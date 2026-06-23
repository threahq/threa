# Threa channel for Claude Code

A [Claude Code channel](https://code.claude.com/docs/en/channels) that links a running Claude Code session to a Threa scratchpad. You type in the scratchpad (from the web app or your phone), the message lands in your local Claude Code session, Claude does the work against your real files, and the reply posts back into the scratchpad.

It is the Claude Code counterpart to `extensions/pi-remote/` and rides the same Threa bot-runtime API, so a linked Claude Code session shows up in Threa exactly like a linked Pi session: a presence pill on the scratchpad, an agent-session trace card, and a `BOT`-tagged reply.

See [`docs/claude-code-channel.md`](../../docs/claude-code-channel.md) for how it works end to end.

## Requirements

- [Bun](https://bun.sh)
- Claude Code 2.1.80 or later (channels are a research-preview feature)
- A Threa **personal** bot with a bot API key (steps below)
- Anthropic auth via claude.ai or a Console API key (channels are not available on Bedrock/Vertex/Foundry)

## Setup

### 1. Create a Threa bot and key

In Threa: **Workspace settings → Bots**.

1. Create a **personal** bot (e.g. "Claude Code"). Give it the **Active scratchpad** trait. Add **Mentionable** too if you also want to reach it with `@`.
2. Open the bot, add an **API key**, and grant these scopes:
   - `bot-runtime:write`
   - `bot-invocations:write`
   - `messages:read`
   - `messages:write` (only needed for permission relay)
   - `streams:read`
   - `attachments:read` (download attachments posted in the scratchpad)
   - `attachments:write` (send local files back with `THREA_ATTACH:`)
3. Copy the key (`threa_bk_…`, shown once) and your workspace id (`ws_…`).

The bot must be **personal**: the session-link endpoint that creates the scratchpad and makes the bot its active actor rejects shared bots. Linking auto-repairs the `active-scratchpad` trait if you forgot it.

### 2. Install dependencies

```bash
cd extensions/claude-code-remote
bun install
```

### 3. Configure credentials

Put the bot key **outside the repo**. Write `~/.claude/threa-channel/config.json` (recommended — it lives in your home dir, so no `git add` can ever reach it), or set environment variables. Environment variables win over the file. Never paste the key into a tracked `.mcp.json` (see the warning in step 4).

```bash
export THREA_WORKSPACE_ID=ws_...
export THREA_API_KEY=threa_bk_...
# optional
export THREA_BASE_URL=https://app.threa.io        # default
export THREA_DISPLAY_NAME="Claude Code"           # prefix; the project dir is appended
export THREA_DEFAULT_LABEL="coding"                # label applied to scratchpads this channel creates
export THREA_PERMISSION_RELAY=1                    # 1 (default) to relay approvals, 0 to disable
```

`~/.claude/threa-channel/config.json`:

```json
{
  "baseUrl": "https://app.threa.io",
  "workspaceId": "ws_...",
  "apiKey": "threa_bk_...",
  "displayName": "Claude Code",
  "defaultLabel": "coding",
  "permissionRelay": true
}
```

### 4. Register the channel with Claude Code

Register the server at **local** scope so it stays private to your machine and never touches a tracked file:

```bash
claude mcp add threa --scope local -- bun /ABSOLUTE/PATH/TO/threa/extensions/claude-code-remote/src/index.ts
```

This writes to `~/.claude.json` under the current project, not to `.mcp.json`. Credentials come from step 3 (the home-dir config file or your shell), so no `env` block is needed. The path to `src/index.ts` must be **absolute**.

> ⚠️ **Do not put your bot key in the Threa repo's `.mcp.json`.** That file is committed and open source — a key pasted there leaks on push. `.mcp.json.example` is intentionally secret-free for this reason. If you'd rather hand-edit a config file than run `claude mcp add`, use the **user-level** `~/.claude.json` (untracked) and not the repo's `.mcp.json`.

If you do want the server defined in a checked-in `.mcp.json` (e.g. to share its existence with a team), keep secrets out of it with environment-variable expansion — `"env": { "THREA_API_KEY": "${THREA_API_KEY}" }` — and provide the value from your shell. Claude Code expands `${VAR}` / `${VAR:-default}` in `.mcp.json` at load time.

### 5. Launch Claude Code with the channel

Custom channels are not on the research-preview allowlist, so start Claude Code with the development flag:

```bash
claude --dangerously-load-development-channels server:threa
```

A dim line under the banner confirms the channel registered. The channel logs the scratchpad URL to stderr on startup (see `~/.claude/debug/<session-id>.txt`); the scratchpad also appears in the Threa sidebar as `Claude Code - <project>`.

### 6. Drive it from Threa

Open the scratchpad in Threa and type a message. No `@`-mention needed: the bot is the scratchpad's active actor, so every message you post is forwarded to your Claude Code session. The presence pill shows **Available** / **Working**. Claude's answer posts back as a `BOT` message.

## Permission relay

Away from the terminal, a tool that needs approval would normally stall the session. With `THREA_PERMISSION_RELAY=1` (default), the approval prompt is posted into the scratchpad as a message:

> **Claude Code wants to run `Bash`**: list the project files
> Reply `yes abcde` to allow or `no abcde` to deny.

Reply `yes <id>` or `no <id>` in the scratchpad and the channel forwards your verdict to Claude Code. The local terminal dialog also stays open, so whichever answer arrives first wins. Anyone who can post in the scratchpad can approve, so only relay in workspaces you trust.

For fully unattended use you can instead skip prompts entirely:

```bash
claude --dangerously-load-development-channels server:threa --dangerously-skip-permissions
```

Only do that in a directory you trust. Also consider pre-allowing the `mcp__threa__reply` tool so posting replies never prompts.

## Attachments

Attachments cross in both directions, mirroring `pi-remote`.

**Inbound.** When a message you send carries attachments, the channel downloads them into `.threa-attachments/<invocation_id>/` under the working directory and lists each local path in the channel event, so Claude can read the files straight from disk. Discovery is best-effort: if the bot key lacks `attachments:read` (or the fetch fails), the prompt still reaches Claude without the files.

**Outbound.** To send a local file back, Claude adds a line to its reply:

```
THREA_ATTACH: ./reports/out.png
```

The channel uploads the file (one per `THREA_ATTACH:` line; paths resolve against the working directory) and rewrites the line into an `[out.png](attachment:…)` link the reply carries into the scratchpad. An upload that fails is reported inline rather than dropping the reply.

## Configuration reference

| Env var                    | Config key         | Default                | Meaning                                                                                 |
| -------------------------- | ------------------ | ---------------------- | --------------------------------------------------------------------------------------- |
| `THREA_BASE_URL`           | `baseUrl`          | `https://app.threa.io` | Threa app origin                                                                        |
| `THREA_WORKSPACE_ID`       | `workspaceId`      | (required)             | `ws_…`                                                                                  |
| `THREA_API_KEY`            | `apiKey`           | (required)             | `threa_bk_…` bot key                                                                    |
| `THREA_DISPLAY_NAME`       | `displayName`      | `Claude Code`          | Scratchpad name prefix; project dir appended                                            |
| `THREA_DEFAULT_LABEL`      | `defaultLabel`     | (none)                 | Label applied to scratchpads this channel creates (only on first creation, not re-link) |
| `THREA_PERMISSION_RELAY`   | `permissionRelay`  | `true`                 | Relay tool-approval prompts into the scratchpad                                         |
| `THREA_POLL_MS`            | `pollMs`           | `3000`                 | Backstop claim poll (the socket pushes faster)                                          |
| `THREA_IDLE_TIMEOUT_MS`    | `idleTimeoutMs`    | `3600000`              | Force-close a turn after this much inactivity (each `send` / approval resets it)        |
| `THREA_INSTANCE_ID`        | `instanceId`       | derived                | Override the per-directory instance id                                                  |
| `THREA_RUNTIME_SESSION_ID` | `runtimeSessionId` | derived                | Override the per-directory session id                                                   |

By default the instance and session ids are derived from your hostname and the working directory, so re-launching Claude Code in the same project reuses the same scratchpad.

## Tests

```bash
bun test
bun run typecheck
```

## Sending multiple messages per turn

Claude has two output tools. `send` posts a progress or intermediate message into the scratchpad and leaves the request open — call it as often as you like during a long task. `reply` posts the final message and closes the request; call it once, last. So a long turn can stream updates as it works and finish with a summary, instead of going silent until a single terminal reply.

Each `send` (and each tool-approval prompt) also counts as a sign of life that resets the idle timeout, so an actively-working turn is never force-closed.

## Limitations

- A channel only sees the inbound message and Claude's `send`/`reply` calls, not its individual tool calls, so the Threa trace card shows a single "working" step rather than the per-tool trace a Pi session produces.
- Claude can't `send` a heartbeat while blocked on a single long tool call (e.g. a 40-minute test run). The idle timeout must exceed your longest single operation — raise `THREA_IDLE_TIMEOUT_MS` if needed. A turn that goes idle without a `reply` is force-closed (silently if it already `send`-ed something, otherwise with a short "ended without a reply" notice).
- One turn at a time: a message sent while Claude is still working is handled after the current reply (a permission verdict is the exception and goes through immediately).

## Roadmap (parity with `pi-remote`)

- Per-tool trace steps — a channel can't observe Claude's tool calls, so matching Pi's rich trace needs a different mechanism than Pi's lifecycle hooks.

## Troubleshooting

- **The channel doesn't show in `/mcp` and never prompts.** If you ever answered "No" to the _"Use this MCP server?"_ prompt for `threa` in a project, Claude Code records it in `disabledMcpjsonServers` in that project's `.claude/settings.local.json` and then silently skips it — no prompt, no `/mcp` entry, no hint. Remove `"threa"` from `disabledMcpjsonServers` (or add it to `enabledMcpjsonServers`) there, or re-enable it from the `/mcp` menu, then restart.
- **`--channels server:threa` warns it's "not on the approved list."** That flag only loads allowlisted plugins; a custom channel is loaded with `--dangerously-load-development-channels server:threa` instead — drop `--channels`.
- **The channel vanished mid-session (scratchpad stuck "busy", no replies).** A stdio MCP server is **not** respawned by Claude Code if it exits — it stays dead until you reconnect it from the `/mcp` menu or relaunch (e.g. `claude --resume … --dangerously-load-development-channels server:threa`). When the channel does go down it now exits gracefully — it marks presence offline and fails the in-flight turn, so the scratchpad flips to offline instead of hanging on "busy", and it logs why: grep `~/.claude/debug/<session-id>.txt` for `[threa-channel] shutting down (…)`. The reason in parentheses tells you the death path: `SIGTERM`/`SIGINT`/`SIGHUP` (Claude Code or your shell stopped it), `stdin closed by parent` (Claude Code crashed or was replaced by an auto-update), or `uncaughtException`/`unhandledRejection` (a bug — file the stack that precedes it).
- **A restart linked the wrong scratchpad / a stale "Claude Code - <project>" lingers.** The scratchpad is keyed by `hostname + cwd` (and the channel runs the `src/index.ts` you registered with `claude mcp add`). Launch Claude Code from a **different git worktree** of the same repo and you get a *different* cwd, hence a *different* scratchpad — and if the worktree you registered against is later moved or deleted, `bun /abs/path/.../src/index.ts` fails to start at all. Register the channel against a **stable checkout path** (your main clone, not a throwaway worktree), or pin `THREA_INSTANCE_ID` / `THREA_RUNTIME_SESSION_ID` so the same scratchpad follows you across directories.
- **Logs.** Diagnostics go to stderr, captured by Claude Code in `~/.claude/debug/<session-id>.txt`: `[threa-channel] linked to scratchpad …` means it connected; `could not link …` means the backend is unreachable (check `THREA_BASE_URL`).
