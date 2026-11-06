/**
 * The GitHub Action (`action.yml` at the repository's root): its script turns the inputs into a
 * `benchfleet-cloud test` command line the CLI accepts, finds the CLI in `cli/` beside it, and takes the inputs as
 * variables (never pasted into the script).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ACTION_DIR = resolve(__dirname, '../..');
const yml = readFileSync(join(ACTION_DIR, 'action.yml'), 'utf8');
const script = /\n {6}run: \|\n((?: {8}.*\n?)+)/.exec(yml)![1]!.replace(/^ {8}/gm, '');

function run(env: Record<string, string>): string[] {
  // `node` stands in for Node: it prints the CLI path and arguments, one per line.
  // As GitHub runs a composite step's `shell: bash`.
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `node() { printf '%s\\n' "$@"; }\n${script}`], {
    env: { ...process.env, GITHUB_ACTION_PATH: ACTION_DIR, BF_ANDROID: '17', BF_MINUTES: '30', BF_TIMEOUT: '30', BF_OUT: 'out', BF_ROOT: 'false', BF_APK: '', BF_PULL: '', BF_SCREEN: '', BF_LOGCAT: '', ...env },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trimEnd().split('\n');
}

describe('the GitHub Action', () => {
  it('builds the test command line from its inputs and runs the CLI from cli/', () => {
    const [cli, ...args] = run({
      BF_COMMAND: 'am instrument -w "com.example.test/androidx.test.runner.AndroidJUnitRunner"',
      BF_APK: 'app/build/app-debug.apk\napp/build/app-debug-androidTest.apk\n',
      BF_PULL: '/sdcard/Download/report.xml',
      BF_SCREEN: 'tablet',
      BF_ROOT: 'true',
      BF_LOGCAT: 'logcat.txt',
    });
    expect(existsSync(cli!)).toBe(true);
    expect(cli!.replace(/\\/g, '/')).toMatch(/\/cli\/src\/cli\.ts$/);
    expect(args).toEqual([
      'test',
      '--command',
      'am instrument -w "com.example.test/androidx.test.runner.AndroidJUnitRunner"',
      '--android',
      '17',
      '--minutes',
      '30',
      '--timeout-min',
      '30',
      '--out',
      'out',
      '--apk',
      'app/build/app-debug.apk',
      '--apk',
      'app/build/app-debug-androidTest.apk',
      '--pull',
      '/sdcard/Download/report.xml',
      '--screen',
      'tablet',
      '--root',
      '--logcat',
      'logcat.txt',
    ]);
  });

  it('never pastes an input into its script', () => {
    expect(script).not.toMatch(/\$\{\{/);
    expect(yml).toMatch(/BENCHFLEET_TOKEN: \$\{\{ inputs\.token \}\}/);
    const [, ...args] = run({ BF_COMMAND: 'echo $(whoami); rm -rf /' });
    expect(args.slice(0, 2)).toEqual(['test', '--command']);
    expect(args[2]).toBe('echo $(whoami); rm -rf /'); // passed as one argument, not run
  });
});
