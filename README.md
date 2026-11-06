# BenchFleet cloud phone

**Run your Android tests on a fresh cloud phone from GitHub Actions.** This Action starts a
[BenchFleet](https://benchfleet.com) cloud phone, installs your APKs, runs your test command in the phone's shell,
fetches your report files and the phone's log, and **always stops the phone**, whether the test passed or failed.
The step fails when your test fails, so your workflow shows it like any other test.

No Android SDK, adb or emulator on the runner: the phone runs on BenchFleet's servers and the Action only needs
Node 24, which it sets up itself. Full guide: [Cloud phones from CI](https://benchfleet.com/docs/cloud-phones-ci).

## Quick start

```yaml
name: Android tests

on: [push, workflow_dispatch]

jobs:
  cloud-phone:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build the app and its tests
        run: ./gradlew assembleDebug assembleDebugAndroidTest

      - name: Test on a BenchFleet cloud phone
        uses: benchfleet/cloud-phone@v1
        with:
          token: ${{ secrets.BENCHFLEET_TOKEN }}
          android: '17'
          minutes: '30'
          apk: |
            app/build/outputs/apk/debug/app-debug.apk
            app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
          command: am instrument -w -r com.example.app.test/androidx.test.runner.AndroidJUnitRunner
          logcat: logcat.txt

      - name: Keep the phone's log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: phone-log
          path: logcat.txt
```

Replace `com.example.app.test` with your own test package and the APK paths with your build's.

## Before you start

1. **A BenchFleet account with cloud phone minutes.** A cloud phone is billed by the minute from your account's
   prepaid minutes, as in the browser, and a phone that started is charged a minimum number of minutes. Current
   prices and minute packs: [benchfleet.com/pricing](https://benchfleet.com/pricing). What a cloud phone is and which
   Android versions are on sale: [Cloud phones](https://benchfleet.com/docs/cloud-phones) and
   [Cloud phone versions](https://benchfleet.com/docs/cloud-phone-versions).
2. **An account API token.** Your account → **API tokens** → Make token
   ([how tokens work](https://benchfleet.com/docs/cloud-phones-ci#_1-make-an-api-token)). Give it an expiry and, if
   you like, its own monthly spending cap and the most phones it may run at once; your account's spending limit
   always applies too.
3. **Keep the token in a secret.** It is shown once. In your repository: Settings → Secrets and variables →
   Actions → New repository secret, named `BENCHFLEET_TOKEN`, and pass it as `token: ${{ secrets.BENCHFLEET_TOKEN }}`.
   Never write the token into a workflow file.

A token can only start, use and stop **its own** cloud phones. It cannot buy minutes, change your account or reach
phones you started in the browser or the BenchFleet app, and revoking it stops it at once.

## Inputs

| Input | Required | Default | What it is |
|---|---|---|---|
| `token` | yes | | An account API token (`bfc_…`). Pass it from a secret. |
| `command` | yes | | The test command, one line, run in the phone's shell, e.g. `am instrument -w …` |
| `apk` | no | | APK files to install first, one per line (the app, then its test APK) |
| `android` | no | `17` | The Android version: `17`, `16`, `15`, `14`, `13` or `12` |
| `screen` | no | | The screen profile: `phone`, `small`, `large`, `tablet` or `foldable` |
| `root` | no | `false` | Root access in the phone |
| `minutes` | no | `30` | The most minutes the phone may run; it is stopped then at the latest |
| `timeout-minutes` | no | `30` | The most minutes the test command may take (at most 120) |
| `pull` | no | | Files to fetch from the phone afterwards, one per line (from `/sdcard/Download` and the other shared folders) |
| `out` | no | `benchfleet-results` | The folder the fetched files go to |
| `logcat` | no | | A file to write the phone's log to while the test runs |
| `url` | no | `https://benchfleet.com` | The service; leave it as it is |

## Outputs and results

The Action has no outputs. The result is the step itself:

| Step result | Meaning |
|---|---|
| passed | your command exited with 0 |
| failed (exit code 1) | your test failed: the command exited with something else |
| failed (exit code 2) | something else went wrong: no minutes left, a spending cap reached, no phone free, an install failed |
| failed (exit code 3) | the test did not finish within `timeout-minutes` |

The files you named in `pull` land in `out`, and the phone's log in `logcat`; upload them with
`actions/upload-artifact` as in the example. A JUnit report your test writes to `/sdcard/Download` can be fetched
the same way and shown by any JUnit reporter Action.

## Examples

**A report file and a tablet screen** (for tests that write their own report to `/sdcard/Download/report.xml`):

```yaml
      - uses: benchfleet/cloud-phone@v1
        with:
          token: ${{ secrets.BENCHFLEET_TOKEN }}
          android: '15'
          screen: tablet
          apk: |
            app-debug.apk
            app-debug-androidTest.apk
          command: am instrument -w -r com.example.app.test/androidx.test.runner.AndroidJUnitRunner
          pull: /sdcard/Download/report.xml
          out: results
```

**Several Android versions at once** (one phone per job, each billed on its own):

```yaml
jobs:
  cloud-phone:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        android: ['17', '15', '13']
    steps:
      - uses: actions/checkout@v4
      - run: ./gradlew assembleDebug assembleDebugAndroidTest
      - uses: benchfleet/cloud-phone@v1
        with:
          token: ${{ secrets.BENCHFLEET_TOKEN }}
          android: ${{ matrix.android }}
          apk: |
            app/build/outputs/apk/debug/app-debug.apk
            app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
          command: am instrument -w -r com.example.app.test/androidx.test.runner.AndroidJUnitRunner
```

More ready-to-copy examples: [benchfleet/examples](https://github.com/benchfleet/examples).

## What goes where

Your APKs, commands, test output and logs go from the runner straight to the server your phone runs on, and are
deleted with the phone. BenchFleet's account service sees only that a phone was started, for how long, and that a
connection was made; never what you install or run. More in
[Privacy and security](https://benchfleet.com/docs/privacy-and-security).

## Good to know

- The phones run Android from the Android Open Source Project, without Google Play. Apps that need Google Play
  services are best tested on real phones.
- Maestro flows, Espresso and Appium suites on your own phones, BenchFleet workflows and AI agents run through the
  [BenchFleet app](https://benchfleet.com/download) ([test suites](https://benchfleet.com/docs/test-suites),
  [workflows](https://benchfleet.com/docs/workflows)).
- Other CI systems: the command-line tool in [`cli/`](cli/) does the same job with one command
  (`node cli/src/cli.ts test …`); see [Cloud phones from CI](https://benchfleet.com/docs/cloud-phones-ci).
- Questions: [support](https://benchfleet.com/support).

## How it works

The Action is a composite step: it sets up Node 24 and runs `cli/src/cli.ts test` with your inputs, which reach the
script only as environment variables (never pasted into it). The tool asks BenchFleet's API to start a phone, waits
until it is ready, connects to the phone's server with a one-use pass, installs, runs, fetches, and stops the phone.
It has no runtime dependencies; its tests run against a fake service (`cd cli && npm ci && npx vitest run`).

## Licence

MIT, for this Action and command-line tool only (see [LICENSE](LICENSE)). The BenchFleet service and app are
proprietary and used under the [BenchFleet terms](https://benchfleet.com/terms).
