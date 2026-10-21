# HFT apprentice bridge runbook

## Process owner

This installation at `/home/jun/git/codex-slack-apprentice` is managed by PM2.
The existing PM2 application is named `hft-apprentice`. Run these commands as the
operator who owns that PM2 application. Byobu is a terminal interface, not the
bridge's process manager; keep the application under PM2 control.

## Inspect, restart, stop, and start

Inspect the application and recent logs:

```sh
pm2 describe hft-apprentice
pm2 logs hft-apprentice --lines 50 --nostream
```

For an authorized restart:

```sh
pm2 restart hft-apprentice
```

To turn the bridge off:

```sh
pm2 stop hft-apprentice
```

To start that existing application again:

```sh
pm2 start hft-apprentice
```

Use the existing application name. Do not kill its PID directly, launch a detached
or foreground replacement, create a second PM2 application, or switch managers.
If PM2 cannot find `hft-apprentice`, check the operator account and report the
missing application rather than starting an unmanaged daemon.

## Deploy a local code change

1. Inspect the intended changes and unmerged branches; preserve unrelated work.
2. Merge intended work into local `main`, run required checks, and build:

   ```sh
   npm run check
   npm test
   npm run build
   ```

3. Commit the intended changes and verify a clean working tree on local `main`.
   A local commit is sufficient; no remote-main match or push is required.
4. Inspect scheduler status and active work before the authorized restart:

   ```sh
   node bin/codex-slack-schedule.mjs --state-dir /home/jun/.local/state/codex-slack status
   ```

5. Run `pm2 restart hft-apprentice` once, then verify recovery below.

Do not push commits or create a PR unless the user explicitly requests it.
Observe the new code for several hours and verify stability before considering
publication; observation alone does not authorize a push. Documentation changes
alone do not require restarting the bridge.

## Verify recovery

```sh
pm2 describe hft-apprentice
pm2 logs hft-apprentice --lines 50 --nostream
node bin/codex-slack-schedule.mjs --state-dir /home/jun/.local/state/codex-slack status
```

Confirm the PM2 application is online, its uptime reflects the restart, logs show
successful startup rather than a restart loop, and the scheduler reports `ready`.
For a routing change, inspect the saved job with `get <job-id>`; do not run a live
scheduled occurrence just to check its configuration.

The bridge owns the Slack-linked agent process, so restarting it may interrupt the
command executor and make a tool result appear aborted. Inspect PM2 and scheduler
health before retrying anything. A lost reply does not prove restart failure and
does not authorize replaying the interrupted task. Report the local commit and
observed runtime state separately from any remote publication.

## Other deployment documentation

The README also describes an alternative systemd installation and the bundled
`bin/codex-slack-restart.mjs` systemd helper. Those instructions do not apply to this
PM2-managed installation. Do not use them as a fallback here.
