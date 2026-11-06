# benchfleet-cloud

Run your Android tests on [BenchFleet](https://benchfleet.com) cloud phones from any CI or your terminal. One
command starts a fresh Android phone billed by the minute, installs your APKs, runs your test, fetches the reports
and the phone's log, and **always stops the phone**, whether the test passed or failed.

```bash
export BENCHFLEET_TOKEN=bfc_…
npx benchfleet-cloud test --android 17 --minutes 30 \
  --apk app-debug.apk --apk app-debug-androidTest.apk \
  --command "am instrument -w -r com.example.app.test/androidx.test.runner.AndroidJUnitRunner" \
  --pull /sdcard/Download/report.xml --logcat logcat.txt
```

In this repository the command runs from this folder: `node cli/src/cli.ts` in place of `npx benchfleet-cloud`
(the npm package is on its way). In GitHub Actions, the simplest way is the Action itself:
[`uses: benchfleet/cloud-phone@v1`](../README.md).

Needs **Node 24** or newer. Nothing else: no Android SDK, no adb, no emulator on the CI machine.

## Before you start

1. A BenchFleet account with cloud phone minutes ([pricing](https://benchfleet.com/pricing)). A phone is billed
   per minute from your prepaid minutes, with a 10-minute minimum per phone.
2. An API token: your account → **API tokens** → Make token. It is shown once: keep it in your CI's secrets as
   `BENCHFLEET_TOKEN`. Each token expires (7 days to a year), can have its own monthly spending cap and the most
   phones it may run at once, and can be revoked at any time. Your account's spending limit always applies too.

A token can only start, use and stop its own cloud phones. It cannot buy minutes, change your account, or reach
phones you started in the browser or the BenchFleet app.

## GitHub Actions

```yaml
jobs:
  android-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: ./gradlew assembleDebug assembleDebugAndroidTest
      - run: >
          npx benchfleet-cloud test --android 17 --minutes 30
          --apk app/build/outputs/apk/debug/app-debug.apk
          --apk app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
          --command "am instrument -w -r com.example.app.test/androidx.test.runner.AndroidJUnitRunner"
          --logcat logcat.txt
        env:
          BENCHFLEET_TOKEN: ${{ secrets.BENCHFLEET_TOKEN }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: phone-log
          path: logcat.txt
```

The step fails when the test fails, so your CI shows it like any other test.

## Commands

| Command | What it does |
|---|---|
| `test --command CMD [--apk FILE]… [--pull PATH]… [--out DIR] [--logcat FILE]` | start, wait, install, run, fetch, and always stop |
| `start [--wait]` | start a phone; prints its rental ID (once it is ready, with `--wait`) |
| `wait RENTAL` | wait until the phone is ready |
| `install RENTAL FILE.apk…` | install apps |
| `run RENTAL -- COMMAND…` | run a command in the phone's shell; exits with the command's exit code |
| `pull RENTAL PATH… [--out DIR]` | fetch files from `/sdcard/Download` and the phone's other shared folders |
| `extend RENTAL --minutes N` | give a running phone more time |
| `stop RENTAL` | stop the phone; billing stops |
| `offers` | the Android versions and screen sizes on sale |
| `balance` | your minutes, and this token's spending this month |

Phone options for `start` and `test`: `--android 17` (11 to 17), `--screen phone|small|large|tablet|foldable`,
`--root`, `--minutes N` (the most the phone may run, default 30), `--name TEXT`. Other options: `--timeout-min M`
(the most a test command may take, default 30, at most 120), `--json` (print the rental as JSON), `--url`,
`--token`.

Environment: `BENCHFLEET_TOKEN` (the API token), `BENCHFLEET_URL` (default `https://benchfleet.com`).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | passed: the test command exited with 0 |
| 1 | the test failed: the command exited with something else |
| 2 | something else went wrong: no minutes left, a spending cap reached, no phone free, an install failed, a wrong option |
| 3 | the test did not finish in time |

## How it works

The tool asks BenchFleet's API to start a phone, waits until it is ready, and then connects straight to the server
the phone runs on with a one-use pass. Your APKs, commands, test output and logs go from your CI to that server and
are deleted with the phone; BenchFleet's account service sees only that a phone ran, for how long, and that a
connection was made.

A test command runs in the phone's shell (for example `am instrument`), as in the Shell tab of the browser view: the
shell stays open while the command runs, for up to two hours.

The same API is open to any language: see [Cloud phones from CI](https://benchfleet.com/docs/cloud-phones-ci).

## Good to know

- The phones run Android from the Android Open Source Project, without Google Play. Apps that need Google Play
  services are best tested on real phones.
- Maestro flows, BenchFleet workflows and AI agents run through the free [BenchFleet app](https://benchfleet.com),
  which can use cloud phones and your own phones.
- Questions: [support](https://benchfleet.com/support).

## Licence

MIT, for this command-line tool only (see `LICENSE`). The BenchFleet service and app are proprietary and used
under the [BenchFleet terms](https://benchfleet.com/terms).
