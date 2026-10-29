import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { checkDocTask, commentOnDoc, createDoc, editDoc, listDocs, readDoc } from "../ops"
import type { RefResolver } from "../resolver"
import { runTool } from "./result"

const REASON =
  "`reason` is one line shown to people on the stream's timeline next to the change, so say what changed and why."

export function registerDocTools(server: McpServer, client: ThreaApiClient, resolver: RefResolver): void {
  server.registerTool(
    "list_docs",
    {
      title: "List docs",
      description:
        "List docs newest first: id, hostStreamId, title, seq (edit counter), createdAt, archived. Without " +
        "`stream_id` it lists every doc this key can read across the workspace; `stream_id` (a stream_ id or " +
        "`#channel-slug`) narrows to the docs one stream hosts. `query` matches doc titles case-insensitively. " +
        "Page by passing the previous response's `cursor` back as `after`; `hasMore` tells you when to stop. " +
        "limit ≤ 200 (default 50). Archived docs and docs under an archived host are omitted unless " +
        "`include_archived` is true.",
      inputSchema: {
        stream_id: z.string().optional(),
        query: z.string().optional(),
        include_archived: z.boolean().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ stream_id, query, include_archived, after, limit }) =>
      runTool(() =>
        listDocs(client, resolver, { streamRef: stream_id, query, includeArchived: include_archived, after, limit })
      )
  )

  server.registerTool(
    "read_doc",
    {
      title: "Read a doc",
      description:
        "Read a whole doc as markdown. A `<!-- blk_… -->` marker line precedes each block; those ids are what " +
        "edit_doc's `block_id` names. Always read before edit_doc and copy `old` text from this output.",
      inputSchema: { doc_id: z.string() },
    },
    async ({ doc_id }) => runTool(() => readDoc(client, doc_id))
  )

  server.registerTool(
    "edit_doc",
    {
      title: "Edit a doc",
      description:
        "Replace text in a doc. Read it first with read_doc, then copy each edit's `old` exactly (verbatim, " +
        "without the marker lines) from a single block; trailing whitespace and surrounding blank lines are " +
        "ignored. `block_id` confines that edit to one block. All edits " +
        "apply together or not at all: if any `old` fails to match, nothing is written. " +
        REASON +
        " A 409 (DOC_EDIT_TEXT_NOT_FOUND, DOC_EDIT_TEXT_AMBIGUOUS, DOC_SECTION_NOT_FOUND) means the text moved or " +
        "matched more than once: re-read the doc (details.scope.markdown holds the current text) and retry with " +
        "a tighter `old`. The result holds only the touched blocks; empty `touchedBlockIds` means nothing changed.",
      inputSchema: {
        doc_id: z.string(),
        reason: z.string().min(1),
        edits: z.array(z.object({ block_id: z.string().optional(), old: z.string(), new: z.string() })).min(1),
      },
    },
    async ({ doc_id, reason, edits }) =>
      runTool(() =>
        editDoc(client, {
          docId: doc_id,
          reason,
          edits: edits.map((e) => ({ ...(e.block_id ? { blockId: e.block_id } : {}), old: e.old, new: e.new })),
        })
      )
  )

  server.registerTool(
    "create_doc",
    {
      title: "Create a doc",
      description:
        "Create a doc hosted by a stream (`stream_id` accepts a stream_ id or `#channel-slug`). `markdown` is the " +
        "initial body; `reason` is required when `markdown` is sent. " +
        REASON,
      inputSchema: {
        stream_id: z.string(),
        title: z.string().optional(),
        markdown: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ stream_id, title, markdown, reason }) =>
      runTool(() => createDoc(client, resolver, { streamRef: stream_id, title, markdown, reason }))
  )

  server.registerTool(
    "comment_on_doc",
    {
      title: "Comment on a doc block",
      description:
        "Post a markdown comment into a doc block's thread, starting the thread on the first comment. `block_id` " +
        "is a `<!-- blk_… -->` marker id from read_doc. `client_message_id` is auto-generated (`mcp-<uuid>`) when you " +
        "omit one so a retried call never double-posts. The result holds `threadId` and the posted message. A 404 " +
        "DOC_SECTION_NOT_FOUND means the doc has no such block: re-read it for the current ids.",
      inputSchema: {
        doc_id: z.string(),
        block_id: z.string(),
        content: z.string().min(1),
        client_message_id: z.string().max(128).optional(),
      },
    },
    async ({ doc_id, block_id, content, client_message_id }) =>
      runTool(() =>
        commentOnDoc(client, { docId: doc_id, blockId: block_id, content, clientMessageId: client_message_id })
      )
  )

  server.registerTool(
    "check_doc_task",
    {
      title: "Tick a doc task item",
      description:
        "Tick (or with `checked: false` untick) one `- [ ] text` task item in a doc. `item` is the text after the " +
        "box, matched exactly (trailing whitespace ignored), nested items included. When several items share the " +
        "text the call fails with DOC_TASK_AMBIGUOUS listing each as {blockId, nth, line}: retry with `nth` " +
        "(1-based, document order) or `block_id`. DOC_TASK_NOT_FOUND means no item reads that way. An item already " +
        "in the wanted state is left alone (`changed: false`). " +
        REASON,
      inputSchema: {
        doc_id: z.string(),
        item: z.string().min(1),
        checked: z.boolean().default(true),
        block_id: z.string().optional(),
        nth: z.number().int().min(1).optional(),
        reason: z.string().min(1),
      },
    },
    async ({ doc_id, item, checked, block_id, nth, reason }) =>
      runTool(() => checkDocTask(client, { docId: doc_id, item, checked, blockId: block_id, nth, reason }))
  )
}
