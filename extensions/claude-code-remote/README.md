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

Either set environment variables, or write `~/.claude/threa-channel/config.json`. Environment variables win over the file.

```bash
export THREA_WORKSPACE_ID=ws_...
export THREA_API_KEY=threa_bk_...
# optional
export THREA_BASE_URL=https://app.threa.io        # default
export THREA_DISPLAY_NAME="Claude Code"           # prefix; the project dir is appended
export THREA_PERMISSION_RELAY=1                    # 1 (default) to relay approvals, 0 to disable
```

`~/.claude/threa-channel/config.json`:

```json
{
  "baseUrl": "https://app.threa.io",
  "workspaceId": "ws_...",
  "apiKey": "threa_bk_...",
  "displayName": "Claude Code",
  "permissionRelay": true
}
```

### 4. Register the channel with Claude Code

Add the server to your MCP config. Use `.mcp.json.example` as a template. For a project, drop it in `.mcp.json`; for all projects, add the block to `~/.claude.json`. User-level config needs the **absolute** path to `src/index.ts`. You can put the credentials in the `env` block instead of the shell.

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

| Env var                    | Config key         | Default                | Meaning                                         |
| -------------------------- | ------------------ | ---------------------- | ----------------------------------------------- |
| `THREA_BASE_URL`           | `baseUrl`          | `https://app.threa.io` | Threa app origin                                |
| `THREA_WORKSPACE_ID`       | `workspaceId`      | (required)             | `ws_…`                                          |
| `THREA_API_KEY`            | `apiKey`           | (required)             | `threa_bk_…` bot key                            |
| `THREA_DISPLAY_NAME`       | `displayName`      | `Claude Code`          | Scratchpad name prefix; project dir appended    |
| `THREA_PERMISSION_RELAY`   | `permissionRelay`  | `true`                 | Relay tool-approval prompts into the scratchpad |
| `THREA_POLL_MS`            | `pollMs`           | `3000`                 | Backstop claim poll (the socket pushes faster)  |
| `THREA_REPLY_TIMEOUT_MS`   | `replyTimeoutMs`   | `1800000`              | Close an unanswered request after this many ms  |
| `THREA_INSTANCE_ID`        | `instanceId`       | derived                | Override the per-directory instance id          |
| `THREA_RUNTIME_SESSION_ID` | `runtimeSessionId` | derived                | Override the per-directory session id           |

By default the instance and session ids are derived from your hostname and the working directory, so re-launching Claude Code in the same project reuses the same scratchpad.

## Tests

```bash
bun test
bun run typecheck
```

## Limitations

- A channel only sees the inbound message and the reply, not Claude's individual tool calls, so the Threa trace card shows a single "working" step rather than the per-tool trace a Pi session produces.
- Claude must call the `reply` tool to close a request. If a turn ends without a reply, the request is force-closed after `replyTimeoutMs` with a short notice.
- One turn at a time: a message sent while Claude is still working is handled after the current reply (a permission verdict is the exception and goes through immediately).

## Roadmap (parity with `pi-remote`)

- Per-tool trace steps — a channel can't observe Claude's tool calls, so matching Pi's rich trace needs a different mechanism than Pi's lifecycle hooks.

## Troubleshooting

- **The channel doesn't show in `/mcp` and never prompts.** If you ever answered "No" to the _"Use this MCP server?"_ prompt for `threa` in a project, Claude Code records it in `disabledMcpjsonServers` in that project's `.claude/settings.local.json` and then silently skips it — no prompt, no `/mcp` entry, no hint. Remove `"threa"` from `disabledMcpjsonServers` (or add it to `enabledMcpjsonServers`) there, or re-enable it from the `/mcp` menu, then restart.
- **`--channels server:threa` warns it's "not on the approved list."** That flag only loads allowlisted plugins; a custom channel is loaded with `--dangerously-load-development-channels server:threa` instead — drop `--channels`.
- **Logs.** Diagnostics go to stderr, captured by Claude Code in `~/.claude/debug/<session-id>.txt`: `[threa-channel] linked to scratchpad …` means it connected; `could not link …` means the backend is unreachable (check `THREA_BASE_URL`).
