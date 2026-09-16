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

Control (`/steer`, `/stop`, `/model`), approvals as decision cards, threads, Hermes-side config, E2EE specifics and the
installer land in later chunks.
