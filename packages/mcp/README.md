# @threa/mcp

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that wraps Threa's public REST API. It gives any local agent — Claude Code inside a Threa worktree, or a completely external project — read and write access to one Threa workspace: streams, users, messages, conversations, memos, attachments, labels, and delegations.

One server instance is bound to one workspace and one API key, both supplied by config. No tool takes a `workspaceId`. There are no WebSockets; every tool is a call against `<baseUrl>/api/v1/workspaces/{workspaceId}/…`.

## Configuration

The server resolves config from environment variables, falling back to an optional JSON file. **Environment variables always win over the file.**

| Setting      | Env var              | File key      | Required | Default                |
| ------------ | -------------------- | ------------- | -------- | ---------------------- |
| API key      | `THREA_API_KEY`      | `apiKey`      | yes      | —                      |
| Workspace id | `THREA_WORKSPACE_ID` | `workspaceId` | yes      | —                      |
| Base URL     | `THREA_BASE_URL`     | `baseUrl`     | no       | `https://app.threa.io` |

The JSON file is read from `THREA_MCP_CONFIG` if set, otherwise from `~/.threa/mcp.json` if it exists. Shape:

```json
{
  "apiKey": "threa_uk_…",
  "workspaceId": "ws_…",
  "baseUrl": "https://app.threa.io"
}
```

If `THREA_API_KEY` or `THREA_WORKSPACE_ID` cannot be resolved from either source, the server exits with an actionable error naming the missing variable. The API key is never logged.

Diagnostics go to stderr (`[threa-mcp] …`); stdout carries only the JSON-RPC transport.

## Running it

The server runs `.ts` directly under [Bun](https://bun.sh) — no build step. It only needs Bun installed and this repository checked out; it works from any project on the machine.

### Register with `claude mcp add` (persistent, local scope)

```bash
claude mcp add threa --scope local \
  --env THREA_API_KEY=threa_uk_… \
  --env THREA_WORKSPACE_ID=ws_… \
  -- bun /abs/path/to/threa/packages/mcp/src/index.ts
```

Replace `/abs/path/to/threa` with the absolute path to your checkout. Add `--env THREA_BASE_URL=…` to point at a non-default host (for example `https://staging.threa.io`).

**Per-worktree gotcha.** Claude Code resolves every worktree of a repo to the same project entry, so a persisted `--scope local` registration made from worktree A silently repoints every other worktree at A's copy of the server the next time they start. If you run multiple worktrees, prefer the session-scoped `--mcp-config` form below, which binds the server to one launch and leaves global config untouched. (Same reason the harness daemon writes a per-session config file rather than calling `claude mcp add`; see `extensions/harness-daemon/src/spawners.ts`.)

### Session-scoped via `--mcp-config`

Write a JSON file and pass it at launch (`claude --mcp-config <path>`):

```json
{
  "mcpServers": {
    "threa": {
      "type": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/threa/packages/mcp/src/index.ts"],
      "env": {
        "THREA_API_KEY": "threa_uk_…",
        "THREA_WORKSPACE_ID": "ws_…",
        "THREA_BASE_URL": "https://app.threa.io"
      }
    }
  }
}
```

This registration lasts only for the launched session and does not touch any other worktree.

## Keys

Mint an API key in the Threa app. The key prefix decides the identity you act as, and the key is bound to one workspace (a mismatched workspace id returns 403).

- **`threa_uk_` — personal access key.** Acts as you, carrying your identity and your access, so it can never do more than you can. Messages it sends are attributed to you and flagged as sent via the API.
- **`threa_bk_` — bot key.** Acts as the bot, with the bot's own identity and access. A personal bot is one you own (your local agent); a workspace bot is a shared, admin-created identity (a CI poster, an integration). Only a bot key can call `request_delegation_access`.

The scopes granted on the key decide which tool areas work. A key without a scope does not get a 403 on those routes — it gets a **404 NOT_FOUND**, because Threa hides existence from keys that cannot see a resource. So a 404 from any tool can mean the resource does not exist _or_ that the key lacks the required scope.

### Scopes by tool area

| Scope               | Unlocks                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| (none)              | `whoami`                                                                                                                                      |
| `streams:read`      | `list_streams`, `get_stream`, `list_stream_members`                                                                                           |
| `users:read`        | `list_users`                                                                                                                                  |
| `messages:read`     | `get_messages`, `find_messages_by_metadata`, `list_conversations`, `get_conversation`, `get_conversation_messages`                            |
| `messages:search`   | `search_messages`                                                                                                                             |
| `messages:write`    | `send_message`, `update_message`, `delete_message`                                                                                            |
| `memos:read`        | `search_memos`, `get_memo`                                                                                                                    |
| `attachments:read`  | `search_attachments`, `get_attachment`, `get_attachment_download_url`                                                                         |
| `labels:read`       | `list_labels`                                                                                                                                 |
| `labels:write`      | `apply_label`, `remove_label`                                                                                                                 |
| `delegations:read`  | `list_delegations`                                                                                                                            |
| `delegations:write` | `claim_delegation`, `delegation_heartbeat`, `report_delegation_status`, `complete_delegation`, `fail_delegation`, `request_delegation_access` |

## Rate limits

The API allows 60 requests per minute per key (and 600 per minute per workspace), over 60-second windows. On a 429 the client retries with exponential backoff (2s, 4s, 8s; three retries) before surfacing a rate-limit error. A 429 is the only automatically retried status (safe for any method — a rate-limited request never executed server-side); every other failure, including transient network errors, surfaces immediately. Pace bulk reads accordingly.

## Tool catalog

Results are JSON text in the API's envelope: single resources under `data`, lists as `{ data, hasMore, cursor? }`, search as `{ data: [...] }`. Failures return an `isError` result carrying `{ code, message, hint? }`. Tools never truncate message content.

### Identity

- **`whoami`** — the authenticated principal (user or bot), the resolved API version, and the base URL and workspace this server is bound to. Run it first to confirm the key.

### Streams

- **`list_streams`** — list accessible streams, filterable by `type` and name `query`; page with `after`.
- **`get_stream`** — one stream by id (type, name, visibility, memory mode).
- **`list_stream_members`** — the users in a stream; page with `cursor`.

### Users

- **`list_users`** — workspace users, filterable by name/slug `query`; page with `after`.

### Messages

- **`get_messages`** — a stream's messages in sequence order. Paging is by numeric `before`/`after` sequence, not a cursor.
- **`search_messages`** — search across accessible streams: full-text by default, `semantic: true` for meaning-based retrieval, `exact: true` for a literal phrase. Scope with `stream_ids` and `type`.
- **`find_messages_by_metadata`** — find messages whose stamped `metadata` contains every given key/value pair (exact match, for dedup and external-reference lookup).
- **`send_message`** — post markdown to a stream. Resume a conversation with `conversation_id` or open one with `start_conversation: true`. An idempotent `client_message_id` is auto-generated when omitted.
- **`update_message`** — replace a message's content. Only messages this key sent.
- **`delete_message`** — delete a message. Only messages this key sent.

### Conversations

- **`list_conversations`** — conversations under a stream's root, filterable by `stream_id` and `status`; page with `cursor`.
- **`get_conversation`** — one conversation (topic summary, status, participants).
- **`get_conversation_messages`** — a conversation's messages in order; page with `cursor`.

### Memos (GAM)

- **`search_memos`** — search the knowledge extracted from this workspace's conversations (decisions, learnings, procedures, context, references). Semantic by default; filter by stream, memo type, knowledge type, tags, scope, and time.
- **`get_memo`** — one memo with its source stream and source messages (provenance).

### Attachments

- **`search_attachments`** — search attachments by filename or extracted content; filter by stream and content type.
- **`get_attachment`** — attachment metadata plus extracted summary and full text when processing has finished.
- **`get_attachment_download_url`** — a short-lived signed URL for the raw bytes.

### Labels

- **`list_labels`** — this key actor's labels and their assignments (labels are private per actor).
- **`apply_label`** — attach a label to a stream by name (found-or-created, idempotent). Optional `color`/`emoji`/`description` overwrite the label everywhere it is used.
- **`remove_label`** — remove this actor's assignment of a label from a stream.

### Delegations

- **`list_delegations`** — open delegated tasks to claim; `since` returns only tasks created after an instant.
- **`claim_delegation`** — atomically claim a task. Returns a `claimToken` shown once, with a 15-minute TTL. The token is also cached in memory for this session.
- **`delegation_heartbeat`** — renew the claim's TTL (liveness only).
- **`report_delegation_status`** — mark the task running and optionally post a progress note; renews the TTL.
- **`complete_delegation`** — terminal success. Optional `result_markdown` is posted into the delegation's stream so GAM memorizes it.
- **`fail_delegation`** — terminal failure with an `error_message`.
- **`request_delegation_access`** — bot-key only. File an access request for a stream the bot cannot yet see.

Lifecycle tools reuse the cached claim token; pass `claim_token` explicitly to override it or to recover after a server restart cleared the cache.
