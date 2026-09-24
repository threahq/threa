# @threahq/cli

`threa` is a command-line client for one Threa workspace. It wraps Threa's public REST API so any local agent or script gets workspace access with one API key: read and search streams, users, messages, conversations, memos, and attachments; send, edit, and delete messages; upload attachments; manage labels; and run the delegation lifecycle end to end.

It is one package with two heads. The command-line interface is the primary head. The same core is also served over the Model Context Protocol with `threa mcp serve`, so an MCP client such as Claude Code can call the same operations as tools. Both heads bind to one workspace and one API key from config, so no command and no tool takes a workspace id. There are no WebSockets; every call goes to `<baseUrl>/api/v1/workspaces/{workspaceId}/…`.

## Install

The CLI needs Node.js 22.13 or newer. Install it globally to put `threa` on your PATH:

```bash
npm install -g @threahq/cli
threa whoami
```

Or run it without installing: `npx -y @threahq/cli whoami`. Update with `npm install -g @threahq/cli@latest`.

From a checkout of this repository it also runs in place under [Bun](https://bun.sh): `bun /abs/path/to/threa/packages/cli/src/cli.ts whoami`.

## Configuration

Config resolves from environment variables and an optional JSON file. Environment variables win over `~/.threa/config.json`. A file named by `THREA_CONFIG` wins over the environment instead, so a runtime that points the CLI at its bot's config cannot be overridden by a `THREA_API_KEY` inherited from a shell; the environment only fills keys that file leaves out.

| Setting      | Env var              | File key      | Required | Default                |
| ------------ | -------------------- | ------------- | -------- | ---------------------- |
| API key      | `THREA_API_KEY`      | `apiKey`      | yes      | none                   |
| Workspace id | `THREA_WORKSPACE_ID` | `workspaceId` | yes      | none                   |
| Base URL     | `THREA_BASE_URL`     | `baseUrl`     | no       | `https://app.threa.io` |
| Principal    | `THREA_PRINCIPAL`    | `principal`   | no       | none (no assertion)    |

The JSON file is read from `THREA_CONFIG` if set, otherwise from `~/.threa/config.json` if it exists (a legacy `~/.threa/mcp.json` is still read, with a hint to rename it). Shape:

```json
{
  "apiKey": "threa_uk_…",
  "workspaceId": "ws_…",
  "baseUrl": "https://app.threa.io",
  "principal": "bot"
}
```

`principal` is `"bot"` or `"user"`. When it is set, the CLI calls `/me` at startup (both the command head and `mcp serve`) and refuses to run when the key's kind differs from the declaration, so a runtime configured to act as its bot can never fall back to a human's key. Without it nothing is asserted.

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
threa streams archive stream_abc                     # archive a stream; unarchive reopens it
threa users list --query alice                      # workspace users
threa search "deploy plan" --what messages          # search messages (--semantic, --exact, --type)
threa search "" --what memos --knowledge-type decision   # browse workspace memory (empty query allowed)
threa search invoice --what attachments             # search attachments by name or extracted text
threa conversations list --stream #eng --status active
threa conversations read conv_123 --limit 50
threa messages find-by-metadata github.pr=org/repo#42 --stream #eng
threa memos list --stream #eng                      # browse recent memos, newest first
threa memos get memo_123
threa attachments list --stream #eng                # browse recent attachments, newest first
threa attachments get att_123 --url                 # --url returns a short-lived signed download URL
threa attachments download att_123 ./               # download bytes; dir dest names it after the file
threa attachments upload ./report.csv               # upload a file; reference it as [report.csv](attachment:<id>)
threa skill print                                   # print the threa-cli agent skill to stdout

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
threa delegations list --since 2026-07-16T00:00:00Z # availability changed after this time
threa delegations get dlg_123                       # inspect before accepting
threa delegations claim dlg_123 --label "Kris's MacBook / Claude Code" --idempotency-key run-abc123
threa delegations update dlg_123                    # manual heartbeat; --note also reports progress
threa delegations release dlg_123                   # controlled stop: return it to the open queue
threa delegations finish dlg_123 --outcome complete --result - < report.md
threa delegations finish dlg_123 --outcome fail --error "build broke"
threa delegations request-access dlg_123            # bot-key only

# end-to-end encryption (your own key, on this machine)
threa e2e unlock                                    # passphrase at the prompt, or piped on stdin
threa e2e unlock --key-store file --key-dir ./keys  # keep it in a 0600 file instead of the OS keychain
threa e2e status                                    # what this machine holds, and whether it is current
threa e2e lock                                      # forget the key here
threa streams read stream_abc                       # a sealed stream opens with that key
threa messages send stream_abc "ship it"            # sealed here; the plaintext never leaves

# mcp head
threa mcp serve
```

Any stream argument (`streams read`, `messages send`, `labels add`, `labels remove`, `search --stream`, `conversations list --stream`, `messages find-by-metadata --stream`) accepts a `stream_…` id or a `#channel-slug`. An `@user-slug` is not resolvable as a stream (a DM hides its counterpart on the wire); pass the DM's `stream_…` id. A ref that matches nothing or is ambiguous fails before any API call with code `UNRESOLVED_REF`.

`messages send` and `messages edit` take content as an argument; `messages send` reads stdin when the content argument is `-`. `delegations finish --result -` also reads the result markdown from stdin.

Once a key is unlocked, `streams read` and `messages send` work on an end-to-end-encrypted stream (a scratchpad or one of its threads) the same way they do on a plaintext one. A read opens each body locally, so what prints is the message rather than the opaque placeholder the server stores; a body sealed to a key generation you were never wrapped to keeps a null `content` and says why, costing you that row and not the page. A send checks the stream first and seals the body under the stream key before anything leaves the machine — the plaintext is never posted, not even once to be rejected. Both take `--key-store` and `--key-dir`. With no key unlocked here, each fails and names `threa e2e unlock` instead of falling back to plaintext. A sealed stream carries no `--metadata` and no conversation: both would travel in the clear, so they are refused rather than dropped.

`e2e unlock` fetches the encrypted bundle holding your identity key, opens it with your passphrase, and files the key where the bot runtimes keep theirs: the OS keychain by default (macOS Keychain, or the freedesktop Secret Service through `secret-tool`). `--key-store file` puts it in a 0600 file under `~/.threa/e2e-keys` instead, or `THREA_E2E_KEY_DIR` when that is set. The passphrase is read from the terminal without echo, or from stdin when one is piped; it never leaves the machine, and neither does the key. Where the key lands is an explicit choice — an unavailable OS keychain is an error naming both options, never a quiet move to disk. Run `unlock` again after changing your passphrase or rotating the key; `status` is what tells you the two have drifted apart.

## Delegation state file

Claim tokens persist to `~/.threa/state.json` (mode 0600), keyed by workspace and delegation, and are written atomically. `threa delegations claim` prints the token once and stores it. `delegations update`, `delegations finish`, and `delegations release` reuse the stored token across invocations. Successful finish clears the token. Successful release clears only the matching stored token and preserves a replacement token; failed or ambiguous requests preserve it. Pass `--claim-token` to override the stored token or recover it on another machine. The MCP head uses the same store, so a claim from one head is usable from the other. Set `THREA_STATE_FILE` to override the path. A corrupt state file logs one warning to stderr and starts empty. A failed write surfaces as a delegation-command error.

## MCP head

### Agent skill

`threa skill install` copies the `threa-cli` skill into `~/.claude/skills/threa-cli/`, so Claude Code sessions in any project on this machine load it on demand. The skill teaches ref forms, the JSON output and exit-code contract, search selection, and the delegation loop. Re-run after pulling a newer checkout. The in-repo copy at `.agents/skills/threa-cli/SKILL.md` is the source of truth. `threa skill print` writes the same markdown to stdout for any other destination.

### The two Threa MCP servers (do not confuse the sends)

A Claude Code session bridged through the remote-control channel also has the channel server `threa-channel` (from `extensions/claude-code-remote`) whose `send` and `reply` tools carry channel invocation ids; `reply` is what closes a channel request. This package's server registers as `threa` and its `send_message` posts a plain message as the API key's identity. It never closes a channel request. In a bridged session, answer channel events with the channel's `reply`; use `threa messages send` / `send_message` for everything else.

`threa mcp serve` runs the same operations as MCP tools over stdio, for an MCP client such as Claude Code.

Register it persistently for the current project:

```bash
claude mcp add threa --scope local \
  --env THREA_API_KEY=threa_uk_… \
  --env THREA_WORKSPACE_ID=ws_… \
  -- threa mcp serve
```

Claude Code maps every worktree of a repo to the same project entry, so a persisted local-scope registration from one worktree repoints the others the next time they start. If you run more than one worktree, prefer a session-scoped registration passed at launch (`claude --mcp-config <path>`):

```json
{
  "mcpServers": {
    "threa": {
      "type": "stdio",
      "command": "threa",
      "args": ["mcp", "serve"],
      "env": {
        "THREA_API_KEY": "threa_uk_…",
        "THREA_WORKSPACE_ID": "ws_…",
        "THREA_BASE_URL": "https://app.threa.io"
      }
    }
  }
}
```

The MCP tools mirror the commands: `whoami`, `list_streams`, `read_stream`, `list_users`, `search`, `list_conversations`, `read_conversation`, `find_messages_by_metadata`, `send_message`, `update_message`, `delete_message`, `list_labels`, `apply_label`, `remove_label`, `get_memo`, `get_attachment`, `get_attachment_download_url`, `list_delegations`, `get_delegation`, `claim_delegation`, `release_delegation`, `update_delegation`, `finish_delegation`, `request_delegation_access`. Tool results are JSON in the API envelope. Failures return `isError` with `{ code, message, hint? }`.

## Keys

Mint an API key in the Threa app. The key prefix decides the identity you act as, and the key is bound to one workspace (a mismatched workspace id returns 403).

- **`threa_uk_` personal access key.** Acts as you, carrying your identity and your access, so it can never do more than you can. Messages it sends are attributed to you and flagged as sent via the API.
- **`threa_bk_` bot key.** Acts as the bot, with the bot's own identity and access. A personal bot is one you own (your local agent); a workspace bot is a shared, admin-created identity such as a CI poster. Only a bot key can call `request-access` / `request_delegation_access`.

The scopes on the key decide which areas work. A key without a scope does not get a 403 on those routes; it gets a **404 NOT_FOUND**, because Threa hides existence from keys that cannot see a resource. So a 404 can mean the resource does not exist or that the key lacks the required scope.

### Scopes by area

| Scope               | Unlocks                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| (none)              | `whoami`                                                                                                             |
| `streams:read`      | `streams list`, `streams read` (stream and member legs)                                                              |
| `streams:write`     | `streams archive`, `streams unarchive`                                                                               |
| `users:read`        | `users list`                                                                                                         |
| `messages:read`     | `streams read` (messages leg), `conversations read`, `conversations list`, `messages find-by-metadata`               |
| `messages:search`   | `search --what messages`                                                                                             |
| `messages:write`    | `messages send`, `messages edit`, `messages delete`                                                                  |
| `memos:read`        | `search --what memos`, `memos list`, `memos get`                                                                     |
| `attachments:read`  | `search --what attachments`, `attachments list`, `attachments get`, `attachments download`                           |
| `attachments:write` | `attachments upload`                                                                                                 |
| `labels:read`       | `labels list`                                                                                                        |
| `labels:write`      | `labels add`, `labels remove`                                                                                        |
| `delegations:read`  | `delegations list`, `delegations get`                                                                                |
| `delegations:write` | `delegations claim`, `delegations release`, `delegations update`, `delegations finish`, `delegations request-access` |

## Rate limits

The API allows 60 requests per minute per key and 600 per minute per workspace, over 60-second windows. On a 429 the client retries with exponential backoff (2s, 4s, 8s; three retries) before surfacing a rate-limit error. A 429 is the only automatically retried status; it is safe for any method because a rate-limited request never executed server-side. Every other failure surfaces immediately. Pace bulk reads accordingly.
