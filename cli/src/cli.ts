#!/usr/bin/env node
/**
 * `benchfleet-cloud`: BenchFleet cloud phones from a terminal or CI (M11.8, CLD-20, D-175).
 *
 *   BENCHFLEET_TOKEN=bfc_… benchfleet-cloud test --apk app.apk --apk app-test.apk \
 *     --command "am instrument -w com.example.test/androidx.test.runner.AndroidJUnitRunner" --minutes 30
 *
 * The token is an account API token from the account page (API tokens): it starts and stops only its own phones,
 * and the account's minutes, spending limit and the token's caps apply as in the browser. Exit codes: 0 passed,
 * 1 the test failed (the command's exit code was not 0), 2 the infrastructure or a wrong option (no minutes, no
 * phone, an install failed), 3 not finished in time. `test` always stops the phone.
 */
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiError, CloudApi, DEFAULT_URL, type Rental } from './api.ts';
import { Door, DoorError, RETRY_CODES } from './door.ts';

export const PASSED = 0;
export const FAILED = 1;
export const INFRA = 2;
export const LATE = 3;

export const USAGE = `usage: benchfleet-cloud <command> [options]

  offers                              the Android versions and screen sizes on sale
  balance                             the account's minutes and this token's spending
  start [phone options] [--wait]      start a phone; prints its rental ID
  wait RENTAL [--timeout S]           wait until the phone is ready
  install RENTAL FILE.apk...          install apps on the phone
  run RENTAL -- COMMAND...            run a command in the phone's shell; exits with its exit code
  pull RENTAL PHONE_PATH... [--out DIR]  fetch files from /sdcard/Download (and the other shared folders)
  extend RENTAL --minutes N           more time for the phone
  stop RENTAL                         stop the phone (billing stops)
  test --command CMD [--apk FILE]... [--pull PHONE_PATH]... [--out DIR] [--logcat FILE] [phone options]
                                      start, wait, install, run, fetch, and always stop

phone options: --android 17 (or --offer bf-android-17) --screen phone --root --minutes 30 --name TEXT
other options: --timeout-min M (a command's time, default 30, at most 120)  --json  --url URL  --token TOKEN

The token and service default to BENCHFLEET_TOKEN and BENCHFLEET_URL (${DEFAULT_URL}); for the private
staging copy, CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET add a Cloudflare Access service token.
Exit codes: 0 passed, 1 the test failed, 2 the infrastructure (or a wrong option), 3 not finished in time.`;

/** A wrong command line: the message is for the person who typed it. */
export class UsageError extends Error {}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Seconds between polls while a phone starts. */
  pollS?: number;
}

const defaultIo: Io = {
  out: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
  env: process.env,
};

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      android: { type: 'string' },
      offer: { type: 'string' },
      screen: { type: 'string' },
      root: { type: 'boolean', default: false },
      minutes: { type: 'string' },
      name: { type: 'string' },
      wait: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '900' },
      'timeout-min': { type: 'string', default: '30' },
      apk: { type: 'string', multiple: true, default: [] },
      command: { type: 'string' },
      pull: { type: 'string', multiple: true, default: [] },
      out: { type: 'string', default: '.' },
      logcat: { type: 'string' },
      json: { type: 'boolean', default: false },
      url: { type: 'string' },
      token: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
}

type Options = ReturnType<typeof parse>['values'];

function int(option: string, value: string | undefined, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${option} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function phoneOptions(v: Options) {
  if (v.android && v.offer) throw new UsageError('give --android or --offer, not both');
  if (v.android && !/^\d{1,3}$/.test(v.android)) throw new UsageError('--android is a version number, such as 17');
  return {
    offer_id: v.offer ?? `bf-android-${v.android ?? '17'}`,
    max_minutes: int('minutes', v.minutes ?? '30', 1, 720),
    ...(v.screen ? { screen: v.screen } : {}),
    ...(v.root ? { root: true } : {}),
    ...(v.name ? { name: v.name } : {}),
  };
}

function rentalArg(positionals: string[]): string {
  const id = positionals[1];
  if (!id || !/^rnt_[a-z2-7]{26}$/.test(id)) throw new UsageError('give the rental ID (rnt_…) that start printed');
  return id;
}

/** A command after `--`, or `--command`. */
function commandText(v: Options, rest: string[]): string {
  const cmd = v.command ?? rest.join(' ');
  if (!cmd.trim()) throw new UsageError('give the command to run: --command "…" or after --');
  if (cmd.includes('\n')) throw new UsageError('the command is one line (join several with ; or &&)');
  return cmd;
}

/** The phone's door; a phone that has just become ready may need a few seconds more (a new grant each try). */
async function connect(api: CloudApi, id: string, tries = 5, waitMs = 3000): Promise<Door> {
  for (let n = 1; ; n += 1) {
    const { url, grant } = await api.connect(id);
    try {
      return await Door.open(url, grant);
    } catch (err) {
      if (!(err instanceof DoorError) || err.code === null || !RETRY_CODES.has(err.code) || n >= tries) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function readApks(paths: string[]): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }[]> {
  return Promise.all(
    paths.map(async (p) => {
      if (!p.toLowerCase().endsWith('.apk')) throw new UsageError(`${p}: only .apk files can be installed`);
      return { name: basename(p).replace(/[^\w .,()+@#=[\]-]/g, '_'), bytes: new Uint8Array(await readFile(p)) };
    }),
  );
}

function show(io: Io, v: Options, r: Rental): void {
  if (v.json) io.out(JSON.stringify(r) + '\n');
  else io.out(`${r.id}\n`);
}

/** Runs one command line; returns the exit code. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let v: Options;
  let positionals: string[];
  const dash = argv.indexOf('--');
  const rest = dash >= 0 ? argv.slice(dash + 1) : [];
  try {
    ({ values: v, positionals } = parse(dash >= 0 ? argv.slice(0, dash) : argv));
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${USAGE}\n`);
    return INFRA;
  }
  const verb = positionals[0];
  if (v.help || !verb) {
    io.out(`${USAGE}\n`);
    return v.help ? PASSED : INFRA;
  }
  const token = v.token ?? io.env.BENCHFLEET_TOKEN ?? '';
  try {
    const access: Record<string, string> = io.env.CF_ACCESS_CLIENT_ID && io.env.CF_ACCESS_CLIENT_SECRET
      ? { 'CF-Access-Client-Id': io.env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': io.env.CF_ACCESS_CLIENT_SECRET }
      : {};
    const api = new CloudApi(token, v.url ?? io.env.BENCHFLEET_URL ?? DEFAULT_URL, io.fetch ?? fetch, access);
    switch (verb) {
      case 'offers':
        io.out(JSON.stringify(await api.offers(), null, 2) + '\n');
        return PASSED;
      case 'balance':
        io.out(JSON.stringify(await api.balance(), null, 2) + '\n');
        return PASSED;
      case 'start': {
        const r = await api.start(phoneOptions(v));
        show(io, v, v.wait ? await api.waitReady(r.id, int('timeout', v.timeout, 1, 3600), io.pollS) : r);
        return PASSED;
      }
      case 'wait':
        show(io, v, await api.waitReady(rentalArg(positionals), int('timeout', v.timeout, 1, 3600), io.pollS));
        return PASSED;
      case 'extend':
        show(io, v, await api.extend(rentalArg(positionals), int('minutes', v.minutes, 1, 720)));
        return PASSED;
      case 'stop':
        show(io, v, await api.release(rentalArg(positionals)));
        return PASSED;
      case 'install': {
        const id = rentalArg(positionals);
        const apks = await readApks(positionals.slice(2));
        if (!apks.length) throw new UsageError('give the .apk files to install');
        const door = await connect(api, id);
        try {
          for (const apk of apks) io.err(`installed ${apk.name}: ${(await door.install(apk.name, apk.bytes)).join(', ') || 'done'}\n`);
        } finally {
          door.close();
        }
        return PASSED;
      }
      case 'run': {
        const id = rentalArg(positionals);
        const cmd = commandText(v, rest);
        const door = await connect(api, id);
        try {
          const r = await door.run(cmd, { timeoutS: int('timeout-min', v['timeout-min'], 1, 120) * 60, output: io.out });
          if (r.timedOut) return LATE;
          if (r.exitCode === null) throw new DoorError(r.reason ?? 'the shell ended');
          return r.exitCode;
        } finally {
          door.close();
        }
      }
      case 'pull': {
        const id = rentalArg(positionals);
        const paths = positionals.slice(2);
        if (!paths.length) throw new UsageError('give the files to fetch, such as /sdcard/Download/report.xml');
        const door = await connect(api, id);
        try {
          await mkdir(v.out, { recursive: true });
          for (const p of paths) {
            const target = join(v.out, basename(p));
            await writeFile(target, await door.pull(p));
            io.err(`fetched ${p} → ${target}\n`);
          }
        } finally {
          door.close();
        }
        return PASSED;
      }
      case 'test':
        return await test(api, v, rest, io);
      default:
        throw new UsageError(`unknown command ${verb}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${USAGE}\n`);
      return INFRA;
    }
    io.err(`benchfleet-cloud: ${describe(err)}\n`);
    return INFRA;
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Start, wait, install, run, fetch, stop: the phone is stopped whatever happens. */
async function test(api: CloudApi, v: Options, rest: string[], io: Io): Promise<number> {
  const cmd = commandText(v, rest);
  const timeoutS = int('timeout-min', v['timeout-min'], 1, 120) * 60;
  const apks = await readApks(v.apk);
  const rental = await api.start(phoneOptions(v));
  io.err(`started ${rental.id} (Android ${rental.android_version ?? '?'}, ${rental.screen}); waiting for it to be ready…\n`);
  let door: Door | null = null;
  try {
    await api.waitReady(rental.id, int('timeout', v.timeout, 1, 3600), io.pollS);
    door = await connect(api, rental.id);
    for (const apk of apks) io.err(`installed ${apk.name}: ${(await door.install(apk.name, apk.bytes)).join(', ') || 'done'}\n`);
    let stopLogs: (() => Promise<void>) | null = null;
    if (v.logcat) {
      const file = v.logcat;
      await writeFile(file, '');
      let chain = Promise.resolve();
      stopLogs = await door.logs((lines) => (chain = chain.then(() => appendFile(file, lines.join('\n') + '\n'))));
      const stop = stopLogs;
      stopLogs = async () => {
        await stop();
        await chain;
      };
    }
    io.err(`running: ${cmd}\n`);
    const r = await door.run(cmd, { timeoutS, output: io.out });
    await stopLogs?.();
    if (v.pull.length) await mkdir(v.out, { recursive: true });
    for (const p of v.pull) {
      try {
        const target = join(v.out, basename(p));
        await writeFile(target, await door.pull(p));
        io.err(`fetched ${p} → ${target}\n`);
      } catch (err) {
        io.err(`could not fetch ${p}: ${describe(err)}\n`);
      }
    }
    if (r.timedOut) {
      io.err(`the command did not finish within ${timeoutS / 60} minutes\n`);
      return LATE;
    }
    if (r.exitCode === null) throw new DoorError(r.reason ?? 'the shell ended');
    io.err(r.exitCode === 0 ? 'passed\n' : `failed: exit code ${r.exitCode}\n`);
    return r.exitCode === 0 ? PASSED : FAILED;
  } finally {
    door?.close();
    try {
      const end = await api.release(rental.id);
      io.err(`stopped ${rental.id} (${end.minutes_used} minutes so far)\n`);
    } catch (err) {
      io.err(`could not stop ${rental.id}: ${describe(err)} — stop it on the website or with: benchfleet-cloud stop ${rental.id}\n`);
    }
  }
}

/** Started as the program (directly, or through npm's `bin` link, which `argv[1]` names without resolving it)? */
function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
