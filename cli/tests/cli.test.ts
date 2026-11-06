/**
 * `benchfleet-cloud` against a fake broker (its `/api/cloud/v1` with an account API token) and a fake phone host
 * viewer that speaks the renter door's frames (`renter_files.py`): start, wait, install, run with the exit code
 * from the marker line, fetch, logs, and the phone always stopped; the exit codes; refusals passed on.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { CloudApi } from '../src/api.ts';
import { FAILED, INFRA, main, PASSED, type Io } from '../src/cli.ts';
import { Door } from '../src/door.ts';

const TOKEN = 'bfc_' + 'A'.repeat(43);
const RENTAL = 'rnt_' + 'a'.repeat(26);

/** A phone host's viewer with the door behind it: answers the door's commands as the gateway would. */
class FakePhone {
  server!: WebSocketServer;
  url = '';
  grants: string[] = [];
  installed: { name: string; bytes: number }[] = [];
  commands: string[] = [];
  typed: string[] = [];
  control = true;
  closeWith: number | null = null;
  /** Run the shell's input in a real `sh` (no terminal, so no echo), as the phone's shell would. */
  realShell = false;

  async start(): Promise<void> {
    this.server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => this.server.once('listening', r));
    this.url = `ws://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    this.server.on('connection', (ws) => this.serve(ws));
  }

  stop(): Promise<void> {
    for (const c of this.server.clients) c.terminate();
    return new Promise((r) => this.server.close(() => r()));
  }

  serve(ws: WebSocket): void {
    let upload: { id: number; size: number; got: number; name: string } | null = null;
    let shell = 0;
    let sh: ChildProcess | null = null;
    const reply = (id: number, ok: boolean, fields: Record<string, unknown> = {}) => ws.send(JSON.stringify({ type: 'cmd', id, ok, ...fields }));
    const frame = (marker: number, id: number, data: string) => {
      const head = Buffer.alloc(5);
      head[0] = marker;
      head.writeUInt32LE(id, 1);
      ws.send(Buffer.concat([head, Buffer.from(data)]));
    };
    ws.once('message', (first) => {
      this.grants.push(JSON.parse(String(first)).grant);
      if (this.closeWith) return ws.close(this.closeWith, 'refused');
      ws.send(JSON.stringify({ type: 'session', control: this.control, width: 720, height: 1344 }));
      ws.send(Buffer.from([0x01, 0, 0, 0, 0, 9, 9])); // a video frame: ignored
      ws.on('message', (data, binary) => {
        if (binary) {
          upload!.got += (data as Buffer).length;
          if (upload!.got === upload!.size) {
            this.installed.push({ name: upload!.name, bytes: upload!.got });
            reply(upload!.id, true, { done: true, installed: true, packages: ['com.example.app'] });
            upload = null;
          }
          return;
        }
        const msg = JSON.parse(String(data));
        this.commands.push(msg.cmd);
        switch (msg.cmd) {
          case 'upload':
            upload = { id: msg.id, size: msg.size, got: 0, name: msg.name };
            return reply(msg.id, true, { ready: true });
          case 'download':
            if (!String(msg.path).startsWith('/sdcard/Download/')) return reply(msg.id, false, { error: 'only files in the folders shown can be downloaded' });
            reply(msg.id, true, { name: 'report.xml', size: 11 });
            frame(0xf1, msg.id, '<ok/>');
            frame(0xf1, msg.id, '<more/>');
            return reply(msg.id, true, { done: true });
          case 'logs':
            if (!msg.on) return reply(msg.id, true, { done: true });
            reply(msg.id, true, { ready: true });
            return reply(msg.id, true, { lines: ['I/Test: one', 'I/Test: two'] });
          case 'shell':
            if (msg.on && this.realShell) {
              shell = msg.id;
              sh = spawn('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] });
              sh.stdout!.on('data', (d: Buffer) => frame(0xf2, shell, d.toString()));
              sh.stderr!.on('data', (d: Buffer) => frame(0xf2, shell, d.toString()));
              sh.on('exit', () => reply(shell, true, { done: true, reason: 'the shell ended' }));
              return reply(msg.id, true, { ready: true, cols: 200, rows: 50 });
            }
            if (!msg.on && sh) {
              sh.kill();
              return reply(msg.id, true, { done: true });
            }
            if (msg.on) {
              shell = msg.id;
              reply(msg.id, true, { ready: true, cols: 200, rows: 50 });
              return frame(0xf2, shell, 'vsoc_x86_64:/ $ ');
            }
            reply(shell, true, { done: true, reason: 'closed by the operator' });
            return reply(msg.id, true, { done: true });
          case 'shell_input': {
            this.typed.push(msg.data);
            if (sh) return void sh.stdin!.write(msg.data);
            const m = /^\((.*)\) <\/dev\/null; printf '\\n%s%s:%s\\n' BFEND ([0-9a-f]+) \$\?\n$/.exec(msg.data);
            if (!m) return;
            const [, cmd, nonce] = m;
            if (cmd!.includes('forever')) return;
            frame(0xf2, shell, `${cmd} output\r\nOK (3 tests)\r\n`);
            return frame(0xf2, shell, `\r\nBFEND${nonce}:${cmd!.includes('fail') ? 1 : 0}\r\n`);
          }
          default:
            return reply(msg.id, false, { error: 'unknown command' });
        }
      });
    });
  }
}

/** The broker's `/api/cloud/v1`, in memory: the rental becomes ready on the second look. */
function fakeBroker(phone: FakePhone, o: { refuse?: { status: number; code: string } } = {}) {
  const calls: string[] = [];
  let looks = 0;
  let state = 'requested';
  const rental = () => ({ id: RENTAL, state, offer_id: 'bf-android-17', android_version: '17', screen: 'phone', root: false, max_minutes: 30, minutes_used: 3, cost: 6, stop_reason: null, error: null, name: null });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${init?.body ? ' ' + String(init.body) : ''}`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const path = url.pathname.replace('/api/cloud/v1', '');
    if (method === 'POST' && path === '/rentals') {
      if (o.refuse) return json(o.refuse.status, { error: { code: o.refuse.code, message: 'refused' } });
      return json(201, { rental: rental() });
    }
    if (method === 'GET' && path === `/rentals/${RENTAL}`) {
      looks += 1;
      if (looks >= 2 && state === 'requested') state = 'ready';
      return json(200, { rental: rental() });
    }
    if (method === 'POST' && path === `/rentals/${RENTAL}/connect`) return json(200, { url: phone.url, grant: `grant-${calls.length}` });
    if (method === 'POST' && path === `/rentals/${RENTAL}/release`) {
      state = 'released';
      return json(200, { rental: rental() });
    }
    if (method === 'GET' && path === '/offers') return json(200, { offers: [{ id: 'bf-android-17', android_version: '17', name: 'Android 17 phone' }], screens: [] });
    return json(404, { error: { code: 'not_found', message: 'no such endpoint' } });
  }) as typeof fetch;
  return { calls, fetcher };
}

let phone: FakePhone;
let dir: string;
let out: string[];
let err: string[];

function io(fetcher: typeof fetch, env: Record<string, string> = {}): Io {
  return { out: (t) => void out.push(t), err: (t) => void err.push(t), env: { BENCHFLEET_TOKEN: TOKEN, BENCHFLEET_URL: 'https://bf.example', ...env }, fetch: fetcher, pollS: 0 };
}

beforeEach(async () => {
  phone = new FakePhone();
  await phone.start();
  dir = mkdtempSync(join(tmpdir(), 'bf-cloud-cli-'));
  out = [];
  err = [];
});

afterEach(async () => {
  await phone.stop();
});

describe('benchfleet-cloud test', () => {
  it('starts, waits, installs, runs, fetches, logs and stops: exit 0 when the command passes', async () => {
    const apk = join(dir, 'app-debug.apk');
    writeFileSync(apk, Buffer.alloc(600 * 1024, 7)); // three upload chunks
    const broker = fakeBroker(phone);
    const code = await main(
      ['test', '--apk', apk, '--command', 'am instrument -w com.example.test', '--android', '17', '--minutes', '30', '--pull', '/sdcard/Download/report.xml', '--out', join(dir, 'out'), '--logcat', join(dir, 'logcat.txt')],
      io(broker.fetcher),
    );
    expect(err.join('')).toContain('passed');
    expect(code).toBe(PASSED);
    expect(broker.calls[0]).toBe('POST /api/cloud/v1/rentals {"offer_id":"bf-android-17","max_minutes":30}');
    expect(broker.calls.at(-1)).toBe(`POST /api/cloud/v1/rentals/${RENTAL}/release`);
    expect(phone.installed).toEqual([{ name: 'app-debug.apk', bytes: 600 * 1024 }]);
    expect(out.join('')).toContain('am instrument -w com.example.test output\nOK (3 tests)\n');
    expect(out.join('')).not.toMatch(/BFEND/);
    expect(readFileSync(join(dir, 'out', 'report.xml'), 'utf8')).toBe('<ok/><more/>');
    expect(readFileSync(join(dir, 'logcat.txt'), 'utf8')).toBe('I/Test: one\nI/Test: two\n');
    // One grant, one connection; the command ran as a subshell with stdin closed, behind echo off.
    expect(phone.grants).toHaveLength(1);
    expect(phone.typed[0]).toContain('stty -echo');
    expect(phone.typed[1]).toMatch(/^\(am instrument -w com\.example\.test\) <\/dev\/null; printf/);
    expect(phone.commands.filter((c) => c === 'shell')).toEqual(['shell', 'shell']); // opened and closed
  });

  it('exits 1 when the command fails, and still stops the phone', async () => {
    const broker = fakeBroker(phone);
    expect(await main(['test', '--command', './run-tests --fail'], io(broker.fetcher))).toBe(FAILED);
    expect(err.join('')).toContain('failed: exit code 1');
    expect(broker.calls.at(-1)).toContain('/release');
  });

  it('sends Ctrl-C to a command that does not finish in time and reports it as timed out (exit 3)', async () => {
    const door = await Door.open(phone.url, 'g');
    const r = await door.run('run forever', { timeoutS: 0.2, output: () => undefined });
    door.close();
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(phone.typed).toContain('');
  });

  it('exits 2 and starts nothing when the broker refuses (no minutes, a cap), with its reason', async () => {
    const broker = fakeBroker(phone, { refuse: { status: 409, code: 'token_spending_limit' } });
    expect(await main(['test', '--command', 'true'], io(broker.fetcher))).toBe(INFRA);
    expect(err.join('')).toContain('(token_spending_limit)');
    expect(broker.calls.some((c) => c.includes('/release'))).toBe(false);
  });

  it('tries again with a new grant while the phone host says the phone is not connected yet', async () => {
    let refusals = 1;
    phone.closeWith = 4404;
    const serve = phone.serve.bind(phone);
    phone.serve = (ws) => {
      if (refusals-- <= 0) phone.closeWith = null;
      serve(ws);
    };
    const broker = fakeBroker(phone);
    const run = main(['run', RENTAL, '--', 'echo', 'hi'], io(broker.fetcher));
    expect(await run).toBe(0);
    expect(broker.calls.filter((c) => c.endsWith('/connect'))).toHaveLength(2);
  }, 15_000);

  it('exits 2 and stops the phone when the host refuses control', async () => {
    phone.closeWith = 4409;
    const broker = fakeBroker(phone);
    expect(await main(['test', '--command', 'true'], io(broker.fetcher))).toBe(INFRA);
    expect(err.join('')).toContain('someone else has control');
    expect(broker.calls.at(-1)).toContain('/release');
  });
});

describe('the other commands and the command line', () => {
  it('run passes the phone command’s exit code on; pull refuses a folder the door does not show', async () => {
    const broker = fakeBroker(phone);
    expect(await main(['run', RENTAL, '--', 'echo', 'hi'], io(broker.fetcher))).toBe(0);
    expect(out.join('')).toContain('echo hi output');
    expect(await main(['run', RENTAL, '--command', 'please fail'], io(broker.fetcher))).toBe(1);
    expect(await main(['pull', RENTAL, '/data/secret.db', '--out', dir], io(broker.fetcher))).toBe(INFRA);
    expect(err.join('')).toContain('only files in the folders shown');
  });

  it('sends a Cloudflare Access service token when one is set (staging), and none otherwise', async () => {
    const seen: (string | undefined)[] = [];
    const fetcher = (async (_: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)['CF-Access-Client-Id']);
      return Response.json({ offers: [], screens: [] });
    }) as typeof fetch;
    await main(['offers'], io(fetcher, { CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 'secret' }));
    await main(['offers'], io(fetcher));
    expect(seen).toEqual(['id.access', undefined]);
  });

  it('reads the exit code from a real POSIX shell, whatever the command prints or how it ends', async () => {
    phone.realShell = true;
    const cases: [string, number, string][] = [
      ['echo "two  words"', 0, 'two  words\n'],
      ['echo partial; printf no-newline; exit 3', 3, 'partial\nno-newline\n'],
      ['false', 1, ''],
      ['echo BFEND 1234 $?', 0, 'BFEND 1234 0\n'], // looks like the marker, is not it
    ];
    for (const [cmd, code, printed] of cases) {
      const door = await Door.open(phone.url, 'g');
      const lines: string[] = [];
      const r = await door.run(cmd, { timeoutS: 10, output: (t) => void lines.push(t) });
      door.close();
      expect([cmd, r.exitCode]).toEqual([cmd, code]);
      expect(lines.join('').replace(/^\n+/, '')).toBe(printed);
    }
  }, 30_000);

  it('start prints the rental ID; --wait waits for ready; stop releases', async () => {
    const broker = fakeBroker(phone);
    expect(await main(['start', '--screen', 'tablet', '--root', '--wait'], io(broker.fetcher))).toBe(PASSED);
    expect(out.join('')).toBe(`${RENTAL}\n`);
    expect(broker.calls[0]).toBe('POST /api/cloud/v1/rentals {"offer_id":"bf-android-17","max_minutes":30,"screen":"tablet","root":true}');
    expect(await main(['stop', RENTAL], io(broker.fetcher))).toBe(PASSED);
  });

  it('refuses wrong command lines and a missing or malformed token, with the usage', async () => {
    const { fetcher } = fakeBroker(phone);
    for (const argv of [[], ['nope'], ['run', 'rnt_bad', '--', 'x'], ['run', RENTAL], ['start', '--minutes', '0'], ['start', '--android', '17', '--offer', 'x'], ['install', RENTAL, 'notes.txt'], ['test', '--command', 'a\nb']]) {
      expect(await main(argv, io(fetcher)), argv.join(' ')).toBe(INFRA);
    }
    expect(await main(['offers'], io(fetcher, { BENCHFLEET_TOKEN: 'not-a-token' }))).toBe(INFRA);
    expect(err.join('')).toContain('bfc_');
    expect(() => new CloudApi('cht_' + 'x'.repeat(43))).toThrow(/bfc_/);
    expect(await main(['--help'], io(fetcher))).toBe(PASSED);
  });
});
