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

The file is read from the path in `THREA_MCP_CONFIG`, or from `~/.threa/mcp.json` when that variable is unset. Its shape is `{ "apiKey": …, "workspaceId": …, "baseUrl": … }`. If the two required values cannot be resolved from either source, the CLI exits with a message naming what is missing. The key is never written to logs.

## Running the CLI

The CLI runs the TypeScript entry point directly under Bun. It needs Bun on the machine and this repository checked out. It works from any project, including projects unrelated to Threa.

Link the bin onto your PATH from `packages/cli` with `bun link`, or invoke the entry point by absolute path:

```bash
bun /abs/path/to/threa/packages/cli/src/cli.ts whoami
```

On a terminal the CLI prints concise human-readable text. When output is piped it prints JSON, which is what an agent or a script reads. The `--json` flag forces JSON on a terminal. Errors go to stderr as one JSON object with `code`, `message`, and an optional `hint`. The exit code is `0` on success, `1` on an API or tool error, and `2` on a usage error such as an unknown command or a missing argument. Run `threa --help` for the command list and `threa <command> --help` for a command's flags.

## Running the MCP server

`threa mcp serve` runs the same operations as MCP tools over stdio. Register it persistently for the current project:

```bash
claude mcp add threa --scope local \
  --env THREA_API_KEY=threa_uk_… \
  --env THREA_WORKSPACE_ID=ws_… \
  -- bun /abs/path/to/threa/packages/cli/src/cli.ts mcp serve
```

Point `--env THREA_BASE_URL` at another host to use staging.

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

Scopes map to command and tool areas as follows. Some operations span more than one scope. Reading a stream (`threa stream`, the `read_stream` tool) reads a stream and its messages in one call, so it needs both `streams:read` and `messages:read`, and a missing scope on either leg fails the whole call. Search routes by its `what`, so it needs the scope for the kind you search.

| Scope               | Commands (MCP tools)                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| none                | `whoami`                                                                                    |
| `streams:read`      | `streams`, `stream` (`list_streams`, `read_stream`)                                         |
| `users:read`        | `users` (`list_users`)                                                                      |
| `messages:read`     | `stream` messages leg, `conversation`, `conversations`, `find-by-metadata`                  |
| `messages:search`   | `search --what messages`                                                                    |
| `messages:write`    | `send`, `edit`, `delete` (`send_message`, `update_message`, `delete_message`)               |
| `memos:read`        | `search --what memos`, `memo` (`get_memo`)                                                  |
| `attachments:read`  | `search --what attachments`, `attachment` (`get_attachment`, `get_attachment_download_url`) |
| `labels:read`       | `labels` (`list_labels`)                                                                    |
| `labels:write`      | `label`, `unlabel` (`apply_label`, `remove_label`)                                          |
| `delegations:read`  | `delegations` (`list_delegations`)                                                          |
| `delegations:write` | `delegations claim`, `update`, `finish`, `request-access`                                   |

## Rate limits

The API allows 60 requests per minute per key and 600 per minute per workspace, measured over 60-second windows. On a 429 the client retries with backoff at 2, 4, and 8 seconds for up to three attempts, then returns a rate-limit error. A 429 is the only status it retries automatically, for reads and writes alike, since a rate-limited request never executed. Any other failure surfaces immediately. Space out bulk reads to stay under the limit.

## Results

Command output is JSON when piped, or human-readable text on a terminal. MCP tool output is JSON text in the API envelope. A single resource comes back under `data`, a list as `{ data, hasMore, cursor? }`, and a search as `{ data: [...] }`. A failure returns an error object with `code`, `message`, and an optional `hint` that spells out the 404 scope case and the rate-limit case. Message content is passed through in full and is never truncated.

## Referencing streams and users

Identifier arguments take either a raw id or a sigil-prefixed slug, so you seldom have to look an id up first. A stream argument accepts a `stream_…` id or a `#channel-slug`, and a `#slug` resolves to the channel whose slug matches exactly. A user argument accepts a `usr_…` or `bot_…` id or an `@user-slug`, and an `@slug` resolves to the user whose slug matches exactly. Resolution is cached for five minutes. A ref that matches nothing or matches more than one candidate fails before any API call with the code `UNRESOLVED_REF` and a message that lists the candidates or points you at the list command or tool.

Two limits come from the public API itself. An `@user-slug` cannot stand in for a DM stream, because DM streams do not expose their counterpart on the wire and there is no lookup for the DM you share with a given user. Find the DM's `stream_…` id with `threa streams --type dm` and `threa stream <id> --members`, then pass that id. Bots and personas are not queryable by slug, because the public API has no bot or persona listing, so `@slug` resolves users only and you pass a `bot_…` or `persona_…` id directly.

## Self-descriptive payloads

Read payloads carry enough identity that a standard read needs no follow-up call. Message rows gain an `author` object with `id`, `type`, `name`, and a `slug` when it can be resolved. A bot or persona author is absent from the users list, so its name falls back to the wire's `authorDisplayName` and its slug is omitted. Conversation objects mirror their `participantIds` with a `participants` array of `id`, `name`, and `slug`. Stream members carry `name` and `slug` from the API. Enrichment is additive and best-effort. The client fetches the workspace users once, caches them, and maps ids locally, so it never adds a fetch per row. If that fetch fails, the raw payload comes back unchanged and one line is written to stderr, so a read never fails because enrichment could not run.

## Command reference

Identity: `whoami` returns the principal, the resolved API version, and the base URL and workspace the client is bound to. Run it first to confirm the key.

Streams: `streams` filters by type and name and pages with `--after`. `stream <ref>` returns one stream together with a page of its messages in a single call, paging the messages by numeric `--before` and `--after` sequence, and returns the stream's members too when `--members` is set.

Users: `users` filters by name or email, and pages with `--after`.

Search: `search <query> --what messages|memos|attachments` is one command routed by `--what`. With `messages` it searches accessible streams full-text, by meaning with `--semantic`, or as a literal phrase with `--exact`, and a query is required. With `memos` it searches the knowledge extracted from the workspace's conversations, the query is optional and matches by meaning, and an empty query browses recent memos. With `attachments` it searches by filename or extracted content, and a query is required. Each `--what` accepts only its own filters, and passing another filter returns an error that names it.

Messages: `find-by-metadata k=v` looks messages up by the metadata stamped on them at send time. `send <stream-ref> <content>` posts markdown, reads stdin when content is `-`, and starts or resumes a conversation with `--new-conversation` or `--conversation`. `edit <message-id> <content>` and `delete <message-id>` act on messages the key itself sent.

Conversations: `conversations` lists conversations under a stream's root. `conversation <id>` returns one conversation together with a page of its messages and pages with `--cursor`.

Memos: `memo <id>` returns a memo with its source messages. Find memos with `search --what memos`.

Attachments: `attachment <id>` returns metadata and extracted text, and `attachment <id> --url` returns a short-lived signed URL for the bytes. Find attachments with `search --what attachments`.

Labels: `labels` lists the key actor's labels, `label <name> <stream-ref>` attaches a label to a stream by name, and `unlabel <name> <stream-ref>` removes the assignment.

Delegations: `delegations` shows open tasks and filters with `--since`. `delegations claim <id> --label who` claims a task and returns a claim token shown once. `delegations update <id>` keeps a claim alive: pass `--note` to mark the task running and post a progress note, or omit it for a pure heartbeat, and either way the claim's TTL is renewed. `delegations finish <id> --outcome complete|fail` ends the task, with `--result` posted into the delegation's stream on success or `--error` recorded on the card on failure. `delegations request-access <id>` is for bot keys that need a grant on the stream.

The claim token is persisted to `~/.threa/state.json` at mode 0600, keyed by workspace and delegation, and written atomically. Update and finish reuse it across separate invocations, and finish clears it. Pass `--claim-token` to override the stored token or to recover it on another machine. Override the file path with `THREA_STATE_FILE`. The MCP head shares the same store, so a claim made through one head is usable from the other. A corrupt state file logs one warning to stderr and starts empty. A failed write surfaces as a delegation-command error rather than passing silently.
