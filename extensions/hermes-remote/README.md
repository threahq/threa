# @threahq/hermes-remote

A Threa connector for a local [Hermes Agent](https://github.com/NousResearch/hermes-agent) gateway. It links a Threa scratchpad to one Hermes
conversation: every turn the scratchpad hands it becomes one Hermes run (`POST /v1/runs`), the run's tool and
subagent events are traced back as steps on the turn, and the run's terminal event closes the turn: the final
output as the reply, a failure as a failed invocation, a cancellation as no response.

## Running it

```sh
bun run start
```

Environment:

| Variable                                                                                      | Required | Default                 |
| --------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| `THREA_WORKSPACE_ID`                                                                          | yes      | none                    |
| `THREA_API_KEY`                                                                               | yes      | none                    |
| `THREA_BASE_URL`                                                                              | no       | `https://app.threa.io`  |
| `HERMES_API_URL`                                                                              | no       | `http://127.0.0.1:8642` |
| `HERMES_API_KEY`                                                                              | yes      | none                    |
| `THREA_E2E`, `THREA_IDLE_TIMEOUT_MS`, and the rest of the `@threahq/remote-session` variables | no       | see that package        |

The same keys can live in `~/.threa/hermes-remote/config.json` (the Hermes ones as `hermesApiUrl` / `hermesApiKey`);
environment variables win.

## What it writes

- `~/.threa/hermes-remote/work`: the connector's working directory, where reply attachments are resolved from.
- `~/.threa/hermes-remote/threa-cli.json`: a `ThreaConfig` (0600) for the `threa` MCP server on the Hermes side, so
  Hermes speaks to the same workspace as the same bot. Point that server's `THREA_CONFIG` at this file.
- `~/.threa/bik-hermes.json`: this install's Bot Identity Key, for sealed scratchpads.

Hermes' `MEDIA: <path>` output lines are rewritten to `THREA_ATTACH: <path>`, so the SDK uploads them as attachments;
an output of exactly `THREA_NO_RESPONSE` closes the turn silently.

## Commands and approvals

The scratchpad offers five session-control commands:

`/stop` stops every open run and closes its turn. `/steer` folds text into the running run; if Hermes will not take it
right now (the run is queued or already finishing) the text is held and prepended to the next turn instead. `/status`
reports the conversation id, every open run with its status, the model this process locked, and the gateway URL.
`/model` locks the conversation to one of the gateway's models, given as `provider::model`, a model id, or any
substring that matches exactly one of them. `/clear` starts a fresh conversation on the scratchpad, which is refused
while any run is open in the session; a model set with `/model` is locked onto the new conversation too, and the
command says so if that lock fails. Commands act on the scratchpad's conversation even when typed in a thread. The
generation counter lives in `~/.threa/hermes-remote/work/conversations.json`, so a new conversation survives a restart.

When Hermes asks to run a command, the request arrives in the scratchpad as a decision card with the command, its
description and the choices Hermes offered (allow once, allow this session, always allow, deny). Answering resolves the
run. A denial with a note sends the note back to the run as a steer. An unanswered card runs into the gateway's own
approval timeout, which denies it. Under Hermes's default `approvals.mode: smart`, its guardian model approves the
flagged commands it judges safe without a card, and only the ones it escalates become cards. Set `approvals.mode:
manual` for a card on every flagged command. The card expires at 5 minutes to match Hermes's default
`approvals.timeout`, and a run that ends withdraws any card still open.

## Threads

The scratchpad is one Hermes conversation, keyed by the stream id. A turn on a thread under the scratchpad or an aside
runs in its own conversation, forked once from the scratchpad's current conversation
(`POST /api/sessions/{root}/fork`), so a thread opens with the scratchpad's context and then diverges: nothing said in
a thread comes back to the scratchpad.

The fork happens on the thread's first turn and is recorded in `conversations.json`, so a restart does not re-fork. If
the scratchpad has not run a turn yet, there is nothing to fork from: the thread starts a fresh conversation and the
connector logs it. Any other fork error fails the turn with the error Hermes returned.

`/clear` bumps the scratchpad's generation only. Threads forked before it keep their own conversation, so their next
turn still carries the pre-clear context; a thread first used after the `/clear` forks from the new conversation.

A mention of the bot outside the scratchpad, in a channel, a DM or one of their threads, is never forked from the
scratchpad. It runs in a fresh conversation keyed by the stream it arrived on, so nothing from the scratchpad reaches
that audience.

The memory scope (`X-Hermes-Session-Key`) is keyed by the turn's root stream. The scratchpad and its threads share
long-term memory, and each channel or DM the bot is mentioned in gets its own.

## Attachments

Inbound: the SDK downloads files attached to a message, including on sealed scratchpads, and appends a manifest of
names and local paths to the turn content. Hermes reads them from those paths.

Outbound: a `THREA_ATTACH: <path>` line in the run output uploads that file and replaces the line with an attachment.
Hermes' own `MEDIA: <path>` lines are rewritten to `THREA_ATTACH:` first, so both work. Relative paths resolve against
`~/.threa/hermes-remote/work`.

## Encrypted scratchpads

Set `THREA_E2E=1` to run against a sealed scratchpad. The connector's Bot Identity Key is written to
`~/.threa/bik-hermes.json` on first start; invite the bot on the encrypted scratchpad so its key is wrapped for it.
Turns, replies, steps and attachments are then sealed end to end.

Decision cards are not sealed yet (the backend refuses `requestDecision` with `E2E_STREAM_PLAINTEXT_UNSUPPORTED`), so
an approval request on a sealed turn is denied automatically and the denial is recorded as a step on the turn. Sealed
cards are THR-121.

## Installing

1. Install Hermes and its gateway:

   ```sh
   curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
   hermes gateway install
   ```

   Set `unattended_mode: approve` in the Hermes config so tool approvals are asked for rather than auto-answered; the
   connector turns each request into a Threa decision card. Register the `threa` MCP server in `~/.hermes/config.yaml`
   so Hermes can read and post in the workspace as the bot (the connector writes the config file it points at):

   ```yaml
   mcp_servers:
     threa:
       command: "bun"
       args: ["/path/to/threa/packages/cli/src/cli.ts", "mcp", "serve"]
       env:
         THREA_CONFIG: "/home/you/.threa/hermes-remote/threa-cli.json"
   ```

2. Write the connector's env file, `~/.config/threa/hermes-remote.env`:

   ```sh
   THREA_WORKSPACE_ID=ws_...
   THREA_API_KEY=...
   THREA_BASE_URL=https://app.threa.io
   THREA_E2E=0
   HERMES_API_URL=http://127.0.0.1:8642
   HERMES_API_KEY=...
   ```

3. Install the systemd user service:

   ```sh
   bun run install-service --start
   ```

   It writes `~/.config/systemd/user/threa-hermes-remote.service` (refusing to overwrite an existing one without
   `--force`), creates `~/.threa/hermes-remote/log/`, installs the `threa` skill into `~/.hermes/skills/threa/SKILL.md`
   and a starting `~/.hermes/SOUL.md` if there is none, then runs `systemctl --user daemon-reload` and
   `enable`. `--start` also restarts the unit; `--dry-run` prints every file and command without doing any of it,
   including an existing unit it would refuse. Any other argument is rejected. Logs land in
   `~/.threa/hermes-remote/log/connector.log`. Linux only.
