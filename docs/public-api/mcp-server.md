# CLI and MCP server

Threa ships `threa`, a command-line client that wraps the public REST API for one workspace. A local agent or a script can read and search streams, users, messages, conversations, memos, and attachments, send and edit messages, manage labels, and run the delegation lifecycle, all with one API key. The same core is served over the Model Context Protocol with `threa mcp serve`, so an MCP client such as Claude Code can call the same operations as tools.

Both heads bind to one workspace and one API key from configuration, so no command and no tool takes a workspace id. There is no long-lived connection. Every call goes to `<baseUrl>/api/v1/workspaces/{workspaceId}/…`. The package lives in this repository at `packages/cli` and runs under Bun with no build step.

## What it needs

One workspace and one API key, both fixed by configuration. Configuration resolves from environment variables first, then from an optional JSON file. Environment variables win over the file.

| Setting      | Environment variable | File key      | Required                               |
| ------------ | -------------------- | ------------- | -------------------------------------- |
| API key      | `THREA_API_KEY`      | `apiKey`      | yes                                    |
| Workspace id | `THREA_WORKSPACE_ID` | `workspaceId` | yes                                    |
| Base URL     | `THREA_BASE_URL`     | `baseUrl`     | no, defaults to `https://app.threa.io` |

The file is read from the path in `THREA_CONFIG`, or from `~/.threa/config.json` when that variable is unset (a legacy `~/.threa/mcp.json` is still read, with a hint to rename it). Its shape is `{ "apiKey": …, "workspaceId": …, "baseUrl": …, "output": … }`, where the optional `output` (`"text"` or `"json"`) sets the default output mode. If the two required values cannot be resolved from either source, the CLI exits with a message naming what is missing. The key is never written to logs.

## Running the CLI

The CLI runs the TypeScript entry point directly under Bun. It needs Bun on the machine and this repository checked out. It works from any project, including projects unrelated to Threa.

Link the bin onto your PATH from `packages/cli` with `bun link`, or invoke the entry point by absolute path:

```bash
bun /abs/path/to/threa/packages/cli/src/cli.ts whoami
```

The CLI prints concise human-readable text by default, piped or not. `-o json` (or `--json`) switches to JSON, works anywhere in the argv, and overrides the config default. Errors go to stderr as one JSON object with `code`, `message`, and an optional `hint`. The exit code is `0` on success, `1` on an API or tool error, and `2` on a usage error such as an unknown command or a missing argument. Run `threa --help` for the command list and `threa <command> --help` for a command's flags.

## Running the MCP server

`threa mcp serve` runs the same operations as MCP tools over stdio. Register it persistently for the current project:

```bash
claude mcp add threa --scope local \
  --env THREA_API_KEY=threa_uk_… \
  --env THREA_WORKSPACE_ID=ws_… \
  -- bun /abs/path/to/threa/packages/cli/src/cli.ts mcp serve
```

Set `--env THREA_BASE_URL` only when connecting to an explicitly provided remote development host.

If you run more than one worktree of the repository, prefer a session-scoped registration. Claude Code maps every worktree of a repo to the same project entry, so a persisted local-scope registration from one worktree repoints the others the next time they start. Passing a config file at launch avoids that:

```json
{
  "mcpServers": {
    "threa": {
      "type": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/threa/packages/cli/src/cli.ts", "mcp", "serve"],
      "env": {
        "THREA_API_KEY": "threa_uk_…",
        "THREA_WORKSPACE_ID": "ws_…"
      }
    }
  }
}
```

Launch with `claude --mcp-config <path>`. The registration lasts for that session only.

## Keys and access

Mint a key in the app. The prefix sets the identity. A `threa_uk_` key is a personal access key. It acts as you, carries your access, cannot do more than you can, and its messages are attributed to you with a via-API marker. A `threa_bk_` key is a bot key. It acts as the bot with the bot's own identity and access. Only a bot key can request access to a delegation's stream.

A key is bound to one workspace, and a request for another workspace returns 403. What a key can do inside its workspace is set by the scopes granted to it. A key that lacks the scope for a resource does not receive a 403 on that route. It receives a 404, because Threa hides existence from keys that cannot see a resource. A 404 from any command or tool therefore means either the resource is absent or the key lacks the scope.

Scopes map to command and tool areas as follows. Some operations span more than one scope. Reading a stream (`threa streams read`, the `read_stream` tool) reads a stream and its messages in one call, so it needs both `streams:read` and `messages:read`, and a missing scope on either leg fails the whole call. Search routes by its `what`, so it needs the scope for the kind you search.

| Scope               | Commands (MCP tools)                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| none                | `whoami`                                                                                                                                                                                                                                   |
| `streams:read`      | `streams list`, `streams read` (`list_streams`, `read_stream`)                                                                                                                                                                             |
| `users:read`        | `users list` (`list_users`)                                                                                                                                                                                                                |
| `messages:read`     | `streams read` messages leg, `conversations read`, `conversations list`, `messages find-by-metadata`                                                                                                                                       |
| `messages:search`   | `search --what messages`                                                                                                                                                                                                                   |
| `messages:write`    | `messages send`, `messages edit`, `messages delete` (`send_message`, `update_message`, `delete_message`)                                                                                                                                   |
| `memos:read`        | `search --what memos`, `memos get` (`get_memo`)                                                                                                                                                                                            |
| `attachments:read`  | `search --what attachments`, `attachments get` (`get_attachment`, `get_attachment_download_url`)                                                                                                                                           |
| `labels:read`       | `labels list` (`list_labels`)                                                                                                                                                                                                              |
| `labels:write`      | `labels add`, `labels remove` (`apply_label`, `remove_label`)                                                                                                                                                                              |
| `delegations:read`  | `delegations list` / `list_delegations`, `delegations get` / `get_delegation`                                                                                                                                                              |
| `delegations:write` | `delegations claim` / `claim_delegation`, `delegations release` / `release_delegation`, `delegations update` / `update_delegation`, `delegations finish` / `finish_delegation`, `delegations request-access` / `request_delegation_access` |

## Rate limits

The API allows 60 requests per minute per key and 600 per minute per workspace, measured over 60-second windows. On a 429 the client retries with backoff at 2, 4, and 8 seconds for up to three attempts, then returns a rate-limit error. A 429 is the only status it retries automatically, for reads and writes alike, since a rate-limited request never executed. Any other failure surfaces immediately. Space out bulk reads to stay under the limit.

## Results

Command output is human-readable text unless `-o json`/`--json` or the config default asks for JSON. MCP tool output is JSON text in the API envelope. A single resource comes back under `data`, a list as `{ data, hasMore, cursor? }`, and a search as `{ data: [...] }`. A failure returns an error object with `code`, `message`, and an optional `hint` that spells out the 404 scope case and the rate-limit case. Message content is passed through in full and is never truncated.

## Referencing streams and users

Identifier arguments take either a raw id or a sigil-prefixed slug, so you seldom have to look an id up first. A stream argument accepts a `stream_…` id or a `#channel-slug`, and a `#slug` resolves to the channel whose slug matches exactly. A user argument accepts a `usr_…` or `bot_…` id or an `@user-slug`, and an `@slug` resolves to the user whose slug matches exactly. Resolution is cached for five minutes. A ref that matches nothing or matches more than one candidate fails before any API call with the code `UNRESOLVED_REF` and a message that lists the candidates or points you at the list command or tool.

Two limits come from the public API itself. An `@user-slug` cannot stand in for a DM stream, because DM streams do not expose their counterpart on the wire and there is no lookup for the DM you share with a given user. Find the DM's `stream_…` id with `threa streams list --type dm` and `threa streams read <id> --members`, then pass that id. Bots and personas are not queryable by slug, because the public API has no bot or persona listing, so `@slug` resolves users only and you pass a `bot_…` or `persona_…` id directly.

## Self-descriptive payloads

Read payloads carry enough identity that a standard read needs no follow-up call. Message rows gain an `author` object with `id`, `type`, `name`, and a `slug` when it can be resolved. A bot or persona author is absent from the users list, so its name falls back to the wire's `authorDisplayName` and its slug is omitted. Conversation objects mirror their `participantIds` with a `participants` array of `id`, `name`, and `slug`. Stream members carry `name` and `slug` from the API. Enrichment is additive and best-effort. The client fetches the workspace users once, caches them, and maps ids locally, so it never adds a fetch per row. If that fetch fails, the raw payload comes back unchanged and one line is written to stderr, so a read never fails because enrichment could not run.

## Command reference

Commands are grouped by noun, each with a verb subcommand (`threa messages send`, `threa streams read`). Every noun requires a verb; `threa <noun>` alone and `threa <noun> --help` list that noun's verbs. There are no aliases. `whoami`, `search`, `skill`, and `mcp` are top-level.

Identity: `whoami` returns the principal, the resolved API version, and the base URL and workspace the client is bound to. Run it first to confirm the key.

Streams: `streams list` filters by type and name and pages with `--after`; archived streams (and live threads under an archived root) are omitted unless `--archived` is passed. `streams read <ref>` returns one stream together with a page of its messages in a single call, paging the messages by numeric `--before` and `--after` sequence, and returns the stream's members too when `--members` is set.

Users: `users list` filters by name or email, and pages with `--after`.

Search: `search <query> --what messages|memos|attachments` is one command routed by `--what`. With `messages` it searches accessible streams full-text, by meaning with `--semantic`, or as a literal phrase with `--exact`, and a query is required. With `memos` it searches the knowledge extracted from the workspace's conversations, the query is optional and matches by meaning, and an empty query browses recent memos. With `attachments` it searches by filename or extracted content, and a query is required. Each `--what` accepts only its own filters, and passing another filter returns an error that names it.

Messages: `messages find-by-metadata k=v` looks messages up by the metadata stamped on them at send time. `messages send <stream-ref> <content>` posts markdown, reads stdin when content is `-`, and starts or resumes a conversation with `--new-conversation` or `--conversation`. `messages edit <message-id> <content>` and `messages delete <message-id>` act on messages the key itself sent.

Conversations: `conversations list` lists conversations under a stream's root. `conversations read <id>` returns one conversation together with a page of its messages and pages with `--cursor`.

Memos: `memos get <id>` returns a memo with its source messages. Find memos with `search --what memos`.

Attachments: `attachments get <id>` returns metadata and extracted text, and `attachments get <id> --url` returns a short-lived signed URL for the bytes. Find attachments with `search --what attachments`.

Labels: `labels list` lists the key actor's labels, `labels add <name> <stream-ref>` attaches a label to a stream by name, and `labels remove <name> <stream-ref>` removes the assignment.

`delegations list` shows open tasks. `--since` filters by availability changes after the timestamp, including reopened tasks. Inspect with `delegations get <id>` before claiming, then run `delegations claim <id> --label <who>`. A historical task still stored as `expired` is not listed but can be inspected and claimed directly by ID. `delegations update <id>` keeps a claim alive: pass `--note` to mark it running and post progress, or omit the note for a manual heartbeat. `delegations release <id>` returns a live claim to the open queue without failing it. `delegations finish <id> --outcome complete|fail` completes or fails the delegation. `delegations request-access <id>` is for bot keys that need a stream grant.

Claim tokens persist to `~/.threa/state.json` (mode 0600), keyed by workspace and delegation, and are written atomically. Update, finish, and release reuse it across invocations. Successful finish clears it. Successful release clears only the matching stored token and preserves a replacement token; a failed or ambiguous request preserves it. Pass `--claim-token` to override the stored token or to recover it on another machine. Override the file path with `THREA_STATE_FILE`. The MCP head shares the same store, so a claim made through one head is usable from the other. A corrupt state file logs one warning to stderr and starts empty. A failed write surfaces as a delegation-command error rather than passing silently.
