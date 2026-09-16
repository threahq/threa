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
run. A denial with a note sends the note back to the run as a steer. Nothing is auto-approved: an unanswered card runs
into the gateway's own approval timeout, which denies it.

Threads, Hermes-side config, E2EE specifics and the installer land in later chunks.
