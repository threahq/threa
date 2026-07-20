---
name: threa-cli
description: >-
  Use the Threa workspace client well, either as the `threa` command-line tool
  (on PATH or run in-repo with `bun packages/cli/src/cli.ts`) or as the Threa MCP
  tools (a `threa` stdio server, tools like whoami / search / send_message /
  claim_delegation). Use when working inside or against a Threa workspace:
  answering "what did we decide / how do we do X" from workspace memory, posting
  or resuming a conversation, running a delegated task to completion, searching
  messages or attachments, or paging large lists. Covers the CLI's JSON output and
  exit-code contract, ref forms, identity-first ordering, memory-before-humans,
  the conversation resume pattern, the delegation claim/update/finish loop with
  persistent tokens, the one `search` command's what selection, cursor paging,
  the 404-may-mean-missing-scope rule, and rate-limit pacing.
---

# Using the Threa workspace client

`threa` is a command-line client for one Threa workspace. The same core is served over MCP with `threa mcp serve`. One key, one workspace, bound at startup. No command and no tool takes a workspace id.

Prefer the CLI when you have a shell. Check for it first: `threa whoami` if it is on PATH, otherwise `bun /abs/path/to/threa/packages/cli/src/cli.ts whoami` from a checkout. If you are an MCP client with the tools loaded instead, use the tool named in each section (the tool names are given alongside the commands).

## The CLI contract

- The CLI prints short human text by default, even when piped. Pass `-o json` (or `--json`, any position in the argv) when you want to parse the output as JSON.
- Exit code `0` is success, `1` is an API or tool error, `2` is a usage error (unknown command or flag, missing argument). On `1` and `2` the error is one JSON object on stderr: `{ code, message, hint? }`.
- Results follow the API envelope: a single resource under `data`, a list as `{ data, hasMore, cursor? }`, a search as `{ data: [...] }`.
- The MCP tools return the same JSON; a failure is an `isError` result carrying `{ code, message, hint? }`.

## Channel sessions have a different `send` (use `reply` to answer)

If your session is bridged through the Threa remote-control channel, you also have the channel MCP server (`threa-channel`) with `send` and `reply` tools bound to channel invocation ids. Those are the ONLY way to answer a `<channel>` event: `reply` closes the request. This skill's `threa messages send` command (and the workspace server's `send_message` tool) posts a plain message as the API key's identity and never closes a channel request. Rule: answering a channel event → channel `reply`; posting anything else into a stream → `threa messages send`. If you answer a channel event with `threa messages send`, the message appears but the request stays open until it expires.

## Start with `whoami`

Run `whoami` (tool `whoami`) before anything else. It confirms the key works, tells you whether you are a `user` or a `bot` principal, and reports the workspace and base URL you are bound to. A user key acts as the person and posts attributed to them; a bot key acts as the bot, and only a bot key can request access to a delegation's stream. Knowing which you are avoids surprises later.

## Refer to streams and users by slug

You rarely need to look up an id first. Any stream argument takes a `stream_…` id or a `#channel-slug`: the `streams read` positional, `messages send`/`labels add`/`labels remove` stream refs, `search --stream`, `conversations list --stream`, `messages find-by-metadata --stream` (tools `read_stream`, `send_message`, `apply_label`, `remove_label`, `search.stream_ids`, `list_conversations.stream_id`, `find_messages_by_metadata.stream_id`). Any user argument takes a `usr_`/`bot_` id or an `@user-slug`. A ref that matches nothing or is ambiguous fails before any API call with `code: "UNRESOLVED_REF"`, listing the candidates or pointing you at `streams list`/`users list`.

Two things you cannot do this way, by design of the API: an `@user-slug` will not stand in for your DM with that user (DM streams hide their counterpart on the wire), and bots and personas are not queryable by slug. For a DM, find its `stream_…` id with `threa streams list --type dm` and `threa streams read <id> --members`; for a bot or persona, pass its id.

## Payloads name their authors

Read results already carry author identity, so you seldom need a second call to name who said what. Message rows carry `author: { id, type, name, slug? }` (a bot or persona author has no slug and its name comes from `authorDisplayName`). Conversations carry a `participants` array parallel to `participantIds` with each participant's name and slug. Stream members carry name and slug. Message search results, attachment rows, and conversations also carry `stream: { id, name?, type? }` — and `rootStream` when the stream is a thread — so you can name the scope without a `streams read`. Use these fields directly instead of listing users or streams per id.

## Search memory before asking a human

`threa search "<idea>" --what memos` (tool `search` with `what: "memos"`) searches GAM, the knowledge Threa extracts from this workspace's conversations: decisions, learnings, procedures, context, references. When the question is "what did we decide", "how do we do X", or "why is it this way", the answer usually already lives there. Search it before you ask a person or guess.

- The query is semantic by default and optional. Pass the idea you are after even if you do not know the exact wording; leave it empty (`--what memos` with no query) to browse the most recent memos.
- Pass `--exact` to match a literal phrase.
- Narrow with `--stream`, `--knowledge-type`, `--memo-type`, `--tag`, `--scope`, and `--before`/`--after`.
- Follow a hit with `threa memos get <id>` (tool `get_memo`) to see the source messages it was extracted from, so you can cite or verify the origin.

## Conversation create and resume

A conversation groups a run of messages under a stream's root. To hold a threaded exchange across multiple sends:

1. On the first send, pass `--new-conversation` (tool: `start_conversation: true`). The result includes `conversationId`.
2. Save that `conversationId`.
3. On every later send in the same exchange, pass `--conversation <saved id>` (tool: `conversation_id`) instead of `--new-conversation`. Setting both is an error before any HTTP call.

The resumed conversation must live under the same root stream as the target, or the API returns 400 `CONVERSATION_NOT_IN_ROOT`. Read a conversation and a page of its messages together with `threa conversations read <id>` (tool `read_conversation`).

`messages send` auto-generates a client message id (`mcp-<uuid>`) when you omit `--client-message-id`, so a retried send never double-posts; it is returned as `clientMessageId`. To dedup across separate attempts, stamp your own `--metadata k=v` (a flat string map) and check with `threa messages find-by-metadata k=v` (tool `find_messages_by_metadata`) before posting, for example `github.pr=org/repo#42`. Send content can be `-` to read from stdin, which is how you post a long body without shell-quoting it.

## The delegation loop

A delegation is a task handed to a local agent. Run the whole loop, and treat the claim token as the thing that keeps the task yours.

1. `threa delegations list` (tool `list_delegations`) shows open tasks. Pass `--since <iso>` to poll for a cheap delta.
2. Before claiming, generate and persist an idempotency key (8 to 128 chars). Then `threa delegations claim <id> --label "who you are" --idempotency-key <key>` (tool `claim_delegation`). The result carries the brief, the context refs, and a `claimToken` shown once.
3. The token is persisted to `~/.threa/state.json` (mode 0600, keyed by workspace and delegation), so later `update` and `finish` calls reuse it across separate `threa` invocations without you passing it. The MCP head shares the same store.
4. The claim has a 15-minute TTL. Run `threa delegations update <id>` (tool `update_delegation`) before it lapses to renew it, or the task returns to the queue. Pass `--note "..."` to also report progress on the card; omit it for a pure heartbeat.
5. Finish with `threa delegations finish <id> --outcome complete|fail` (tool `finish_delegation`). On `complete`, pass `--result <md>` (or `-` to read stdin) to post the outcome into the delegation's stream so GAM memorizes it, and `--metadata k=v` to stamp that message. On `fail`, pass `--error <msg>`. Finish clears the stored token.

Token recovery: `update` and `finish` read the stored token, so you normally omit it. Pass `--claim-token <t>` (tool `claim_token`) to override it or to recover it on another machine. If you crashed mid-task, re-run claim with the same persisted idempotency key: it re-keys your own live claim and hands back a fresh token and lease instead of a 409. A plain 409 `DELEGATION_NOT_OPEN` means another runner won the race.

If you are a bot key and cannot claim a task because the bot lacks a grant on its stream, run `threa delegations request-access <id>` (tool `request_delegation_access`) to file an approval card. A user key cannot do this; a user's access follows the person, who should join the stream.

## Choose the right search

One `search` command covers all three kinds; pick with `--what`, and pass only the filters that `--what` supports (passing another one is an error that names it).

- **`--what messages`**, default full-text: you know the words that appear in the message. Add `--semantic` when you know the idea but not the wording, or `--exact` to match the query as a literal phrase. Query required.
- **`--what memos`**: search workspace memory (see the memory section). Query optional and semantic; an empty query browses recent memos.
- **`--what attachments`**: search files by filename or extracted content, then `threa attachments get <id>` (tool `get_attachment`) for the full extracted text, or `threa attachments get <id> --url` (tool `get_attachment_download_url`) only when you need the raw bytes' URL. Query optional; omit it to browse the most recent attachments. `threa attachments download <id> [dest]` fetches the bytes to disk — a directory dest names the file after the attachment (`name (1).ext` on conflict), a file dest is written as given.
- **Recent-first browsing**: `threa memos list` and `threa attachments list` (both take repeatable `--stream` and `--limit`) are shorthand for a query-less search — use them for "what's new here" instead of inventing a query.
- **`messages find-by-metadata`**: you want messages by a reference you stamped at send time, not by text. It is exact key/value AND-containment, the right tool for dedup and external-id lookup.

## Paging

Most lists return `{ data, hasMore, cursor }`. When `hasMore` is true, pass `cursor` back as the paging argument (`--after` for `streams list` and `users list`, `--cursor` for `conversations list`) and repeat until `hasMore` is false. Two exceptions:

- `streams read` pages its messages by numeric message sequence. The messages envelope is `{ data, hasMore }` with no cursor. Walk pages with `--before` (older) or `--after` (newer), taking the boundary message's `sequence`. Pass at most one. Its member list (with `--members`) pages by cursor.
- `search` returns `{ data: [...] }` and is bounded by `--limit` and time filters rather than a cursor.

## 404 can mean missing scope

Threa hides existence from a key that lacks a scope, so a missing scope returns 404 rather than 403. If a command returns 404 for a resource you expect to exist, the key may simply lack the scope for that area (for example `memos:read` for memo lookups, `delegations:write` for the delegation lifecycle). The error hint says so. Check the key's scopes before concluding the resource is gone.

## Pace bulk reads

The limit is 60 requests per minute per key. The client already retries a 429 with backoff (2s, 4s, 8s) before giving up, but that burns wall-clock time. When walking many pages or fanning out searches, keep well under 60 calls per minute rather than sprinting into the limit. A 429 is the only automatically retried status; it is safe for any method because a rate-limited request never executed. Any other failure surfaces immediately, so handle transient errors yourself if a call matters.
