# Operating the Slack bridge

Read README.md before changing daemon lifecycle or session delivery.

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

The restart helper enforces a clean, committed local main checkout without contacting
a remote. Report the local commit and live verification separately. Do not describe
a local deployment as pushed or published.

## Restarting from a Slack-linked Codex session

This chat's Codex app-server and shell tools can be children of `codex-slack.service`.
`systemctl --user restart codex-slack.service` kills the command executor as well as
the bridge. A tool result of `aborted` is therefore ambiguous: the restart may have
succeeded. It is not evidence of an approval rejection. Do not repeatedly restart.

After building and testing an authorized change, use:

```sh
node /home/erik/work/projects/codex-slack/bin/codex-slack-restart.mjs
```

The helper uses `CODEX_THREAD_ID` (or `--session <id>`), saves a durable handoff,
and schedules an independent systemd restart. New daemon startup sends a readiness
notice into the original Codex session through the bridge inbox. It does not replay
the interrupted task. Use the normal execution escalation mechanism if the sandbox
blocks systemd or the private control socket; prior user restart authorization is enough.

If the result is interrupted or uncertain, inspect instead of repeating the mutation:

```sh
node /home/erik/work/projects/codex-slack/bin/codex-slack-restart.mjs status
systemctl --user show codex-slack.service -p ActiveState -p InvocationID -p ExecMainStartTimestamp
```

`queued` means the readiness notice entered the durable inbox, not that its model
reply was delivered. See README.md for failure recovery and the independent log.
