# @threa/cli

`threa` is a command-line client for one Threa workspace. It wraps Threa's public REST API so any local agent or script gets workspace access with one API key: read and search streams, users, messages, conversations, memos, and attachments; send, edit, and delete messages; manage labels; and run the delegation lifecycle end to end.

It is one package with two heads. The command-line interface is the primary head. The same core is also served over the Model Context Protocol with `threa mcp serve`, so an MCP client such as Claude Code can call the same operations as tools. Both heads bind to one workspace and one API key from config, so no command and no tool takes a workspace id. There are no WebSockets; every call goes to `<baseUrl>/api/v1/workspaces/{workspaceId}/…`.

## Install

The CLI runs `.ts` directly under [Bun](https://bun.sh) with no build step. It needs Bun on the machine and this repository checked out. It works from any project on the machine.

Link the `threa` bin onto your PATH from the package directory:

```bash
cd /abs/path/to/threa/packages/cli
bun link
```

Or skip linking and invoke the entry point directly:

```bash
bun /abs/path/to/threa/packages/cli/src/cli.ts whoami
```

If you keep the CLI on PATH for a Claude Code session, add the bin directory to PATH in the environment Claude Code launches with, or call it by absolute path. Replace `/abs/path/to/threa` throughout with the absolute path to your checkout.

## Configuration

Config resolves from environment variables first, then from an optional JSON file. Environment variables win over the file.

| Setting      | Env var              | File key      | Required | Default                |
| ------------ | -------------------- | ------------- | -------- | ---------------------- |
| API key      | `THREA_API_KEY`      | `apiKey`      | yes      | none                   |
| Workspace id | `THREA_WORKSPACE_ID` | `workspaceId` | yes      | none                   |
| Base URL     | `THREA_BASE_URL`     | `baseUrl`     | no       | `https://app.threa.io` |

The JSON file is read from `THREA_CONFIG` if set, otherwise from `~/.threa/config.json` if it exists (a legacy `~/.threa/mcp.json` is still read, with a hint to rename it). Shape:

```json
{
  "apiKey": "threa_uk_…",
  "workspaceId": "ws_…",
  "baseUrl": "https://app.threa.io"
}
```

If `THREA_API_KEY` or `THREA_WORKSPACE_ID` cannot be resolved from either source, the CLI exits with an actionable error naming the missing variable. The API key is never logged.

## Output and exit codes

The CLI prints concise human-readable text by default, piped or not. `-o json` (or `--json`) switches to pretty JSON, and the flag works anywhere in the argv (`threa --json streams list` == `threa streams list --json`). A config-file `"output": "json"` sets the default; an explicit flag wins. Errors always go to stderr as one JSON object `{ code, message, hint? }`.

Exit codes:

- `0` success
- `1` API or tool error (the stderr object carries the API `code` and, on a 404, a hint that the code may mean the key lacks the scope)
- `2` usage error (unknown command or flag, missing argument); the command's usage line goes to stderr

Run `threa --help` for the command list and `threa <command> --help` for a command's flags. The help output is complete enough to operate a command from it alone.

## Command catalog

Commands are grouped by noun, with a verb subcommand under each noun (the `gh`/`railway` pattern). Every noun requires a subcommand; `threa <noun>` alone (and `threa <noun> --help`) lists that noun's verbs. There are no aliases. `whoami`, `search`, `skill`, and `mcp` are top-level.

```bash
threa whoami                                        # authenticated principal, api version, binding
threa streams list --type channel --query eng       # list accessible streams (page with --after)
threa streams read #eng --members --limit 20        # a stream plus a page of its messages
threa users list --query alice                      # workspace users
threa search "deploy plan" --what messages          # search messages (--semantic, --exact, --type)
threa search "" --what memos --knowledge-type decision   # browse workspace memory (empty query allowed)
threa search invoice --what attachments             # search attachments by name or extracted text
threa conversations list --stream #eng --status active
threa conversations read conv_123 --limit 50
threa messages find-by-metadata github.pr=org/repo#42 --stream #eng
threa memos get memo_123
threa attachments get att_123 --url                 # --url returns a short-lived signed download URL

# writes
threa messages send #eng "Deploy is green"          # post markdown (content `-` reads stdin)
threa messages send #eng - --new-conversation < notes.md # open a conversation from piped content
threa messages send #eng "reply" --conversation conv_123 --metadata run=42
threa messages edit msg_123 "corrected text"
threa messages delete msg_123
threa labels list
threa labels add urgent #eng --color '#ff0000' --emoji 🔥
threa labels remove urgent #eng

# delegations
threa delegations list --since 2026-07-16T00:00:00Z
threa delegations claim dlg_123 --label "Kris's MacBook / Claude Code" --idempotency-key run-abc123
threa delegations update dlg_123 --note "halfway through"
threa delegations finish dlg_123 --outcome complete --result - < report.md
threa delegations finish dlg_123 --outcome fail --error "build broke"
threa delegations request-access dlg_123            # bot-key only

# mcp head
threa mcp serve
```

Any stream argument (`streams read`, `messages send`, `labels add`, `labels remove`, `search --stream`, `conversations list --stream`, `messages find-by-metadata --stream`) accepts a `stream_…` id or a `#channel-slug`. An `@user-slug` is not resolvable as a stream (a DM hides its counterpart on the wire); pass the DM's `stream_…` id. A ref that matches nothing or is ambiguous fails before any API call with code `UNRESOLVED_REF`.

`messages send` and `messages edit` take content as an argument; `messages send` reads stdin when the content argument is `-`. `delegations finish --result -` also reads the result markdown from stdin.

## Delegation state file

Claim tokens are persisted to `~/.threa/state.json` (mode 0600), keyed by workspace and delegation, written atomically. `threa delegations claim` prints the token once and stores it; `delegations update` and `delegations finish` reuse the stored token across separate `threa` invocations, and `finish` clears it. Pass `--claim-token` to override the stored token or to recover it on another machine. The same store backs the MCP head, so a claim made through one head is usable from the other. Override the path with `THREA_STATE_FILE`. A corrupt state file logs one warning to stderr and starts empty; a failed write surfaces as a delegation-command error.

## MCP head

### Agent skill

`threa skill install` copies the `threa-cli` skill into `~/.claude/skills/threa-cli/`, so Claude Code sessions in any project on this machine load it on demand. The skill teaches ref forms, the JSON output and exit-code contract, search selection, and the delegation loop. Re-run after pulling a newer checkout. The in-repo copy at `.agents/skills/threa-cli/SKILL.md` is the source of truth.

### The two Threa MCP servers (do not confuse the sends)

A Claude Code session bridged through the remote-control channel also has the channel server `threa-channel` (from `extensions/claude-code-remote`) whose `send` and `reply` tools carry channel invocation ids; `reply` is what closes a channel request. This package's server registers as `threa` and its `send_message` posts a plain message as the API key's identity. It never closes a channel request. In a bridged session, answer channel events with the channel's `reply`; use `threa messages send` / `send_message` for everything else.

`threa mcp serve` runs the same operations as MCP tools over stdio, for an MCP client such as Claude Code.

Register it persistently for the current project:

```bash
claude mcp add threa --scope local \
  --env THREA_API_KEY=threa_uk_… \
  --env THREA_WORKSPACE_ID=ws_… \
  -- bun /abs/path/to/threa/packages/cli/src/cli.ts mcp serve
```

Claude Code maps every worktree of a repo to the same project entry, so a persisted local-scope registration from one worktree repoints the others the next time they start. If you run more than one worktree, prefer a session-scoped registration passed at launch (`claude --mcp-config <path>`):

```json
{
  "mcpServers": {
    "threa": {
      "type": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/threa/packages/cli/src/cli.ts", "mcp", "serve"],
      "env": {
        "THREA_API_KEY": "threa_uk_…",
        "THREA_WORKSPACE_ID": "ws_…",
        "THREA_BASE_URL": "https://app.threa.io"
      }
    }
  }
}
```

The MCP tools mirror the commands: `whoami`, `list_streams`, `read_stream`, `list_users`, `search`, `list_conversations`, `read_conversation`, `find_messages_by_metadata`, `send_message`, `update_message`, `delete_message`, `list_labels`, `apply_label`, `remove_label`, `get_memo`, `get_attachment`, `get_attachment_download_url`, `list_delegations`, `claim_delegation`, `update_delegation`, `finish_delegation`, `request_delegation_access`. Tool results are JSON in the API envelope; failures come back as `isError` results carrying `{ code, message, hint? }`.

## Keys

Mint an API key in the Threa app. The key prefix decides the identity you act as, and the key is bound to one workspace (a mismatched workspace id returns 403).

- **`threa_uk_` personal access key.** Acts as you, carrying your identity and your access, so it can never do more than you can. Messages it sends are attributed to you and flagged as sent via the API.
- **`threa_bk_` bot key.** Acts as the bot, with the bot's own identity and access. A personal bot is one you own (your local agent); a workspace bot is a shared, admin-created identity such as a CI poster. Only a bot key can call `request-access` / `request_delegation_access`.

The scopes on the key decide which areas work. A key without a scope does not get a 403 on those routes; it gets a **404 NOT_FOUND**, because Threa hides existence from keys that cannot see a resource. So a 404 can mean the resource does not exist or that the key lacks the required scope.

### Scopes by area

| Scope               | Unlocks                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| (none)              | `whoami`                                                                                               |
| `streams:read`      | `streams list`, `streams read` (stream and member legs)                                                |
| `users:read`        | `users list`                                                                                           |
| `messages:read`     | `streams read` (messages leg), `conversations read`, `conversations list`, `messages find-by-metadata` |
| `messages:search`   | `search --what messages`                                                                               |
| `messages:write`    | `messages send`, `messages edit`, `messages delete`                                                    |
| `memos:read`        | `search --what memos`, `memos get`                                                                     |
| `attachments:read`  | `search --what attachments`, `attachments get`                                                         |
| `labels:read`       | `labels list`                                                                                          |
| `labels:write`      | `labels add`, `labels remove`                                                                          |
| `delegations:read`  | `delegations list`                                                                                     |
| `delegations:write` | `delegations claim`, `delegations update`, `delegations finish`, `delegations request-access`          |

## Rate limits

The API allows 60 requests per minute per key and 600 per minute per workspace, over 60-second windows. On a 429 the client retries with exponential backoff (2s, 4s, 8s; three retries) before surfacing a rate-limit error. A 429 is the only automatically retried status; it is safe for any method because a rate-limited request never executed server-side. Every other failure surfaces immediately. Pace bulk reads accordingly.
