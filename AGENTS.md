# Operating the Slack bridge

Read README.md and RUNBOOK.md before changing daemon lifecycle or session delivery.

## Complete changes before deploying locally

The persistent local daemon runs this checkout. Before a normal restart, merge the
intended work into `main`, run required checks, commit, and verify a clean working
tree. A local commit is sufficient; no push or remote-main match is required.
Inspect unmerged local branches for features still used by the daemon before
rebuilding from main. Do not delete branches containing unmerged work.

Do not create pull requests or push Git commits unless the user explicitly requests
that action. Restarting or deploying locally does not authorize a push or PR.
Run the new code locally for several hours and verify stability before considering
publication; elapsed time alone never authorizes it. Push only when explicitly
requested after that observation period.

Normal restarts require a clean, committed local main checkout without contacting
a remote. Report the local commit and live verification separately. Do not describe
a local deployment as pushed or published.

## Process management and restarts

This installation is managed by **PM2**, under the existing application name
`hft-apprentice`. Follow [RUNBOOK.md](RUNBOOK.md). For an authorized restart, use:

```sh
pm2 restart hft-apprentice
```

Preserve PM2 ownership of the process. Do not kill the bridge PID directly, launch a
replacement with nohup/spawn/detach or from byobu, create another PM2 application, or
switch it to systemd. The bundled `codex-slack-restart.mjs` helper uses systemd and
is not the restart command for this installation.

To stop or start the existing application, use `pm2 stop hft-apprentice` or
`pm2 start hft-apprentice`, respectively. A documentation change alone does not
require a restart. If PM2 cannot find the application, report the problem rather
than launching an unmanaged replacement.

A restart from a Slack-linked session may interrupt that session's tool executor.
An aborted tool result is ambiguous; inspect `pm2 describe hft-apprentice`, recent
PM2 logs, and scheduler health before considering another restart. Do not repeat a
restart or replay interrupted work solely because a reply was lost.
