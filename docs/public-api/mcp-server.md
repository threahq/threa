# MCP server

Threa ships a Model Context Protocol server that wraps the public REST API. It lets a local agent, such as Claude Code, work against one Threa workspace through MCP tools instead of raw HTTP: read and search streams, users, messages, conversations, memos, and attachments, send and edit messages, manage labels, and run the delegation lifecycle.

The server speaks stdio and holds no long-lived connection. Every tool is a single call against `<baseUrl>/api/v1/workspaces/{workspaceId}/…`. It lives in this repository at `packages/mcp` and runs under Bun with no build step.

## What it needs

One workspace and one API key, both fixed by configuration. No tool takes a workspace id, because the server is bound to one workspace when it starts. The key decides who the agent acts as and what it can touch.

Configuration resolves from environment variables first, then from an optional JSON file. Environment variables win over the file.

| Setting      | Environment variable | File key      | Required                               |
| ------------ | -------------------- | ------------- | -------------------------------------- |
| API key      | `THREA_API_KEY`      | `apiKey`      | yes                                    |
| Workspace id | `THREA_WORKSPACE_ID` | `workspaceId` | yes                                    |
| Base URL     | `THREA_BASE_URL`     | `baseUrl`     | no, defaults to `https://app.threa.io` |

The file is read from the path in `THREA_MCP_CONFIG`, or from `~/.threa/mcp.json` when that variable is unset. Its shape is `{ "apiKey": …, "workspaceId": …, "baseUrl": … }`. If the two required values cannot be resolved from either source, the server exits with a message naming what is missing. The key is never written to logs.

## Registering it

The server runs the TypeScript entry point directly under Bun. It needs Bun on the machine and this repository checked out. It works from any project, including projects that have nothing to do with Threa.

To register it persistently for the current project:

```bash
claude mcp add threa --scope local \
  --env THREA_API_KEY=threa_uk_… \
  --env THREA_WORKSPACE_ID=ws_… \
  -- bun /abs/path/to/threa/packages/mcp/src/index.ts
```

Point `--env THREA_BASE_URL` at another host to use staging.

If you run more than one worktree of the repository, prefer a session-scoped registration. Claude Code maps every worktree of a repo to the same project entry, so a persisted local-scope registration from one worktree repoints the others the next time they start. Passing a config file at launch avoids that:

```json
{
  "mcpServers": {
    "threa": {
      "type": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/threa/packages/mcp/src/index.ts"],
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

Mint a key in the app. The prefix sets the identity. A `threa_uk_` key is a personal access key: it acts as you, carries your access, and cannot do more than you can, and its messages are attributed to you with a via-API marker. A `threa_bk_` key is a bot key: it acts as the bot with the bot's own identity and access. Only a bot key can call `request_delegation_access`.

A key is bound to one workspace, and a request for another workspace returns 403. What a key can do inside its workspace is set by the scopes granted to it. A key that lacks the scope for a resource does not receive a 403 on that route. It receives a 404, because Threa hides existence from keys that cannot see a resource. A 404 from any tool therefore means either the resource is absent or the key lacks the scope.

Scopes map to tool areas as follows.

| Scope               | Tools                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| none                | `whoami`                                                                                                                                      |
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

The API allows 60 requests per minute per key and 600 per minute per workspace, measured over 60-second windows. On a 429 the server retries with backoff at 2, 4, and 8 seconds for up to three attempts, then returns a rate-limit error. A 429 is the only status it retries automatically, for reads and writes alike, since a rate-limited request never executed. Any other failure surfaces immediately. Space out bulk reads to stay under the limit.

## Tool results

Tool output is JSON text in the API envelope. A single resource comes back under `data`, a list as `{ data, hasMore, cursor? }`, and a search as `{ data: [...] }`. A failure returns an error result with `{ code, message, hint? }`, and the hint spells out the 404 scope case and the rate-limit case. Message content is passed through in full and never truncated.

## Tool catalog

Identity: `whoami` returns the principal, the resolved API version, and the base URL and workspace the server is bound to.

Streams: `list_streams` filters by type and name and pages with `after`; `get_stream` reads one stream; `list_stream_members` lists a stream's members and pages with `cursor`.

Users: `list_users` filters by name or slug and pages with `after`.

Messages: `get_messages` reads a stream in sequence order, paging by numeric `before` and `after`; `search_messages` searches accessible streams full-text, by meaning with `semantic`, or as a literal phrase with `exact`; `find_messages_by_metadata` looks messages up by the metadata stamped on them at send time; `send_message` posts markdown and can start or resume a conversation; `update_message` and `delete_message` act on messages the key itself sent.

Conversations: `list_conversations` lists conversations under a stream's root; `get_conversation` reads one; `get_conversation_messages` walks its messages.

Memos: `search_memos` searches the knowledge extracted from the workspace's conversations, and `get_memo` returns a memo with its source messages.

Attachments: `search_attachments` searches by filename or extracted content; `get_attachment` returns metadata and extracted text; `get_attachment_download_url` returns a short-lived signed URL for the bytes.

Labels: `list_labels` lists the key actor's labels; `apply_label` attaches a label to a stream by name; `remove_label` removes the assignment.

Delegations: `list_delegations` shows open tasks; `claim_delegation` claims one and returns a claim token that is shown once and cached in memory for the session; `delegation_heartbeat` and `report_delegation_status` renew the claim while work is in flight; `complete_delegation` and `fail_delegation` end it; `request_delegation_access` is for bot keys that need a grant on the stream. Lifecycle tools reuse the cached token, and you can pass `claim_token` to override it or to recover after a restart.
