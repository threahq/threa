# @threahq/t3code-remote

A Threa connector for a [T3 Code](https://github.com/pingdotgg/t3code) server. It links a Threa scratchpad to T3
Code threads. Each turn the scratchpad hands it becomes one T3 run on whichever provider the thread uses (Claude,
Codex, OpenCode). The run's tool calls are traced back as steps, and its final assistant message is the reply.

It speaks only T3's MCP endpoint (`/mcp`) and polls it: `t3_thread_wait` returns when the run settles or after two
seconds, and each return reads the thread's new activity. Nothing needs T3's WebSocket, so a remote or headless
T3 server works the same as a local one.

## Running it

```sh
npm install -g @threahq/t3code-remote
threa-t3code
```

From a checkout of the Threa repo, `bun install` then `bun run start` in `extensions/t3code-remote` runs it from
source.

Environment:

| Variable                                                                                               | Required | Default                 |
| ------------------------------------------------------------------------------------------------------ | -------- | ----------------------- |
| `THREA_WORKSPACE_ID`                                                                                   | yes      | none                    |
| `THREA_API_KEY`                                                                                        | yes      | none                    |
| `THREA_BASE_URL`                                                                                       | no       | `https://app.threa.io`  |
| `T3CODE_URL`                                                                                           | no       | `http://127.0.0.1:3773` |
| `T3CODE_ACCESS`                                                                                        | no       | `full-access`           |
| `T3CODE_PROJECT_ID`                                                                                    | no       | none (scratch threads)  |
| `T3CODE_AUTO_LOGIN`                                                                                    | no       | off                     |
| `THREA_TRACE_MODE`, `THREA_SEALED_FULL_TRACE`, and the rest of the `@threahq/remote-session` variables | no       | see that package        |

The same keys can live in `~/.threa/t3code-remote/config.json`, the T3 ones as `t3Url`, `t3Access`, `t3ProjectId`
and `t3AutoLogin`. Environment variables win.

## Running it as a service

On Linux, `threa-t3code-install --start` writes a systemd user unit, then enables and starts it. The unit runs the
installed package with the node that installed it, so `npm update -g @threahq/t3code-remote` and a
`systemctl --user restart threa-t3code-remote` upgrade it. The installer refuses to run from `npx`, whose cache npm
clears under a running unit. From a checkout, `bun run install-service --start` writes a unit that runs the source
with bun.

It writes `~/.config/systemd/user/threa-t3code-remote.service` (refusing to overwrite an existing one without
`--force`) and creates `~/.threa/t3code-remote/log/`, where the connector's output lands. `--dry-run` prints the
plan and touches nothing. The unit reads its environment from `~/.config/threa/t3code-remote.env`, one `KEY=value`
per line. With auto-login on, the connector runs `t3`, so put a `PATH` that reaches it in that file: a `PATH` there
replaces the unit's own, so include the directory of the node or bun the unit runs too.

The connector changes into `~/.threa/t3code-remote/work` wherever it is started, and downloads attachments there.
Its scratchpad identity comes from the host name and that directory, so the service and a manual run link to the
same scratchpad.

## Logging in to T3 Code

The connector needs an MCP token from the T3 server. T3 issues one in exchange for a pairing code, and the token
lasts 30 days.

- `threa-t3code login` mints a pairing code with the local `t3` CLI (`t3 auth pairing create`), exchanges it and saves
  the token to `~/.threa/t3code-remote/token.json`. Run it on the T3 host.
- `threa-t3code login <code>` exchanges a code you created yourself.
- With `t3AutoLogin: true` (or `T3CODE_AUTO_LOGIN=1`) the connector does this itself on start and again whenever T3
  rejects the token. It needs `t3` on `PATH`, and `T3CODE_HOME` set if the server keeps its state somewhere other
  than `~/.t3`.

Without auto-login the connector refuses to start with no token, and a rejected token fails the turn with the login
hint.

`t3Access` is the permission ceiling the token asks for and every launched thread runs at. Keep it at
`full-access`: Threa can't answer T3's approval or question prompts yet, so a run that stops on one is interrupted
and its turn fails with a message saying why.

## Threads

The scratchpad is one T3 thread. Its first turn launches the thread, in its own scratch folder or in `t3ProjectId`
when set, and later turns queue on it. A thread under the scratchpad forks the scratchpad's T3 thread on its first
turn, so it starts with the scratchpad's context and then diverges. A mention outside the scratchpad, in a channel or
a DM, launches its own thread and never sees the scratchpad's context. The stream-to-thread links live in
`~/.threa/t3code-remote/work/threads.json`, so a restart picks the same threads back up.

A thread launched in a project follows T3's default for new threads: the project's own setting, else the environment's.
When that is a new worktree, T3 makes the worktree and names its branch. It starts from the checkout's `HEAD`, or from
origin's default branch when T3 is set to start new worktrees from origin. T3 can't report a default kept in the
project's `t3.json`, so set it in T3's settings instead.

Every thread is a normal T3 thread, so you can open it in the T3 app and keep going there.

Stopping the connector leaves T3's runs alone: they finish in T3, and their Threa turns end with "T3 Code connector
shut down".

Attachments on a message are downloaded and listed by path in the text T3 receives. PNG, JPEG, GIF and WebP images up
to 10 MiB, at most 8 per message, are also uploaded to T3 and sent as images, so the model sees them without reading
a file. T3 sends a message with images in its own "auto" mode: it is steered into the thread's open run when there is
one, and otherwise starts a run straight away instead of queueing. A failed upload fails the turn.

A damaged `threads.json` or `token.json` stops the connector at start instead of being read as empty.

## Commands

- `/stop` interrupts the open runs and closes their turns.
- A message sent while a run is open is steered into it when T3 accepts that, and otherwise queued as the next turn.
- `/status` shows the scratchpad's thread, its model, the open runs and the T3 URL.
- `/model` picks a model from the T3 server's providers, as `instance::model`, a model id, or a substring matching
  one of them. It moves the scratchpad's thread and every thread launched after it. Threads that already exist under
  the scratchpad or elsewhere keep theirs. A scratch thread can't launch until one is picked. After that, new threads
  launch on the model the last run used, so a model changed in T3 carries over too.
- `/clear` starts a new T3 thread for the scratchpad. It is refused while a turn is open.

## Traces and replies

Tool calls (commands, file changes, searches, subagents) show as steps. `headline` mode shows only what kind of tool
ran; `commands` mode adds the command's first line, since T3 sends a command and its output as one text. On an encrypted scratchpad with `sealedFullTrace` on (the default), steps
also carry command output, file change details and reasoning.

An assistant message followed by more work is posted as a narration step, and the last one is the reply. A
`THREA_ATTACH: /absolute/path` line in the reply uploads that file, and a reply of exactly `THREA_NO_RESPONSE` closes the
turn silently. Each new thread's first message tells the agent both.
