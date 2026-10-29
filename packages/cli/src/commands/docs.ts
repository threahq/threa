import { checkDocTask, commentOnDoc, createDoc, editDoc, listDocs, moveDoc, readDoc } from "../ops"
import { VISIBILITIES } from "../tools/constants"
import {
  arrayFlag,
  boolFlag,
  enumFlag,
  intFlag,
  renderList,
  stringFlag,
  UsageError,
  type NounSpec,
  type VerbSpec,
} from "../output"

interface DocRow {
  id?: string
  hostStreamId?: string | null
  archived?: boolean
  title?: string | null
  seq?: number
  markdown?: string
  touchedBlockIds?: string[]
}

function hostLabel(hostStreamId: string | null | undefined): string {
  if (hostStreamId === null) return "(top level)"
  return hostStreamId ?? "?"
}

const listVerb: VerbSpec = {
  name: "list",
  summary: "List docs across the workspace or on one stream, newest first",
  usage: "threa docs list [<stream-ref>] [--query q] [--archived] [--after cursor] [--limit n]",
  help:
    "threa docs list [<stream-ref>] [flags]\n\n" +
    "List docs this key can read, newest first. Without <stream-ref> it searches the whole workspace; " +
    "<stream-ref> (a stream_ id or #channel-slug) narrows to the docs that stream hosts. Each row is the doc id, " +
    "its title (or (untitled)), its seq (the edit counter) and its host stream, or (top level) for a doc with " +
    "none. Page by passing the previous response's cursor back as --after.\n\n" +
    "Flags:\n" +
    "  --query q    case-insensitive match on the doc title\n" +
    "  --archived   include archived docs and docs under archived hosts\n" +
    "  --after c    pagination cursor from a previous response\n" +
    "  --limit n    max results, <= 200 (default 50)\n" +
    "  --json       force JSON output\n" +
    "  --help       show this help",
  options: {
    query: { type: "string" },
    archived: { type: "boolean" },
    after: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, positionals, values) =>
    listDocs(ctx.client, ctx.resolver, {
      streamRef: positionals[0],
      query: stringFlag(values, "query"),
      includeArchived: boolFlag(values, "archived"),
      after: stringFlag(values, "after"),
      limit: intFlag(values, "limit"),
    }),
  render: (payload) =>
    renderList<DocRow>(
      payload,
      (d) =>
        `${d.id ?? "?"}  ${d.title || "(untitled)"}  ${d.seq ?? "?"}  ${hostLabel(d.hostStreamId)}` +
        (d.archived ? "  [archived]" : ""),
      { empty: "(no docs)", cursorFlag: "after" }
    ),
}

const readVerb: VerbSpec = {
  name: "read",
  summary: "Print a doc as markdown with its block markers",
  usage: "threa docs read <doc-id>",
  help:
    "threa docs read <doc-id> [flags]\n\n" +
    "Print the whole doc as markdown. A `<!-- blk_… -->` marker line precedes each block; those block ids are " +
    "what `docs edit --block` names. Read a doc before editing it and copy --old text from this output.\n\n" +
    "Flags:\n" +
    "  --json    print the full envelope (id, hostStreamId, title, seq, createdAt, markdown)\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("docs read requires a <doc-id>")
    return readDoc(ctx.client, id)
  },
  render: (payload) => (payload as { data?: DocRow }).data?.markdown ?? "",
}

const editVerb: VerbSpec = {
  name: "edit",
  summary: "Replace exact text in a doc, every edit applied together or not at all",
  usage: "threa docs edit <doc-id> --reason r --old a --new b [--old c --new d ...] [--block blk_x]",
  help:
    "threa docs edit <doc-id> --reason r --old a --new b [flags]\n\n" +
    "Replace text in a doc. --old and --new are repeatable and pair by position: the first --old with the first " +
    "--new, and so on. Copy each --old verbatim from one block of `threa docs read`; trailing whitespace and " +
    "surrounding blank lines are ignored. All edits apply together; " +
    "if any --old fails to match, nothing is written. A 409 (DOC_EDIT_TEXT_NOT_FOUND, DOC_EDIT_TEXT_AMBIGUOUS, " +
    "DOC_SECTION_NOT_FOUND) means the text moved or matched more than once: re-read the doc and retry with a " +
    "tighter --old (details.scope.markdown holds the current text). A value that starts with a dash, such as a " +
    'list item, needs the = form: --old="- AWS key is live". To tick a task: --old "[ ] text" --new "[x] text".\n\n' +
    "Flags:\n" +
    "  --reason r     required; one line shown to people on the stream's timeline\n" +
    "  --old a        text to replace (repeatable, pairs with --new by position)\n" +
    "  --new b        replacement text (repeatable)\n" +
    "  --block blk_x  confine every edit in this call to one block\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    reason: { type: "string" },
    old: { type: "string", multiple: true },
    new: { type: "string", multiple: true },
    block: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const docId = positionals[0]
    if (!docId) throw new UsageError("docs edit requires a <doc-id>")
    const reason = stringFlag(values, "reason")
    if (!reason) throw new UsageError("docs edit requires --reason (one line shown on the stream's timeline)")
    const olds = arrayFlag(values, "old") ?? []
    const news = arrayFlag(values, "new") ?? []
    if (olds.length === 0) throw new UsageError("docs edit requires at least one --old/--new pair")
    if (olds.length !== news.length) {
      throw new UsageError(
        `docs edit pairs --old with --new by position; got ${olds.length} --old and ${news.length} --new`
      )
    }
    const blockId = stringFlag(values, "block")
    const edits = olds.map((old, i) => ({ ...(blockId ? { blockId } : {}), old, new: news[i]! }))
    return editDoc(ctx.client, { docId, reason, edits })
  },
  render: (payload) => {
    const d = (payload as { data?: DocRow }).data
    const touched = d?.touchedBlockIds ?? []
    if (touched.length === 0) return "no change"
    return `edited ${d?.id ?? "?"} seq ${d?.seq ?? "?"}: ${touched.length} block(s)`
  },
}

const createVerb: VerbSpec = {
  name: "create",
  summary: "Create a doc, hosted by a stream or top-level",
  usage: "threa docs create [<stream-ref>] [--visibility v] [--title t] [--body text | --body -] [--reason r]",
  help:
    "threa docs create [<stream-ref>] [flags]\n\n" +
    "Create a doc hosted by a stream. <stream-ref> is a stream_ id or #channel-slug. Without it the doc is " +
    "top-level: like a channel, private unless --visibility says otherwise, with you as its only member; only a " +
    "user key creates one. The body is markdown; `--body -` reads it from stdin. --reason is required with --body.\n\n" +
    "Flags:\n" +
    "  --visibility v private|public|guest_public, top-level docs only (default private)\n" +
    "  --title t      doc title\n" +
    "  --body text    initial markdown, or - to read stdin\n" +
    "  --reason r     one line shown to people on the stream's timeline (required with --body)\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    visibility: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    reason: { type: "string" },
  },
  run: async (ctx, positionals, values) => {
    const ref = positionals[0]
    const visibility = enumFlag(values, "visibility", VISIBILITIES)
    if (ref && visibility) {
      throw new UsageError("docs create --visibility is for top-level docs; a hosted doc takes its stream's")
    }
    const rawBody = stringFlag(values, "body")
    const reason = stringFlag(values, "reason")
    if (rawBody !== undefined && !reason) throw new UsageError("docs create --body requires --reason")
    const markdown = rawBody === "-" ? await ctx.readStdin() : rawBody
    return createDoc(ctx.client, ctx.resolver, {
      streamRef: ref,
      visibility,
      title: stringFlag(values, "title"),
      markdown,
      reason,
    })
  },
  render: (payload) => {
    const d = (payload as { data?: DocRow }).data
    return d?.title ? `created ${d.id ?? "?"}  ${d.title}` : `created ${d?.id ?? "?"}`
  },
}

const commentVerb: VerbSpec = {
  name: "comment",
  summary: "Comment on a doc block, in that block's thread",
  usage: "threa docs comment <doc-id> --block blk_x --body <text | -> [--client-message-id id]",
  help:
    "threa docs comment <doc-id> --block blk_x --body <text | -> [flags]\n\n" +
    "Post a markdown comment into a block's thread, starting the thread on the first comment. Block ids are the " +
    "`<!-- blk_… -->` markers in `threa docs read`; `--body -` reads the comment from stdin. A client message id is generated when " +
    "you omit --client-message-id, so a retried post never double-posts. A 404 " +
    "DOC_SECTION_NOT_FOUND means the doc has no such block: re-read it for the current ids.\n\n" +
    "Flags:\n" +
    "  --block blk_x  the block to comment on (required)\n" +
    "  --body text    the comment as markdown, or - to read stdin (required)\n" +
    "  --client-message-id id  set the idempotency key explicitly (<= 128 chars)\n" +
    "  --json         print the envelope (threadId, the posted message, clientMessageId)\n" +
    "  --help         show this help",
  options: {
    block: { type: "string" },
    body: { type: "string" },
    "client-message-id": { type: "string" },
  },
  run: async (ctx, positionals, values) => {
    const docId = positionals[0]
    if (!docId) throw new UsageError("docs comment requires a <doc-id>")
    const blockId = stringFlag(values, "block")
    if (!blockId) throw new UsageError("docs comment requires --block blk_x (a block id from `threa docs read`)")
    const rawBody = stringFlag(values, "body")
    if (rawBody === undefined) throw new UsageError("docs comment requires --body <text> (or `-` to read stdin)")
    const content = rawBody === "-" ? await ctx.readStdin() : rawBody
    if (content.trim() === "") throw new UsageError("comment body is empty")
    return commentOnDoc(ctx.client, {
      docId,
      blockId,
      content,
      clientMessageId: stringFlag(values, "client-message-id"),
    })
  },
  render: (payload) => {
    const p = payload as { data?: { threadId?: string } }
    return `commented in thread ${p.data?.threadId ?? "?"}`
  },
}

const checkVerb: VerbSpec = {
  name: "check",
  summary: "Tick or untick one task-list item in a doc",
  usage: 'threa docs check <doc-id> --item "text" --reason r [--uncheck] [--block blk_x] [--nth N]',
  help:
    'threa docs check <doc-id> --item "text" --reason r [flags]\n\n' +
    "Tick a `- [ ] text` item (or untick it with --uncheck). --item is the text after the box, matched exactly " +
    "(trailing whitespace ignored), so `foo` never hits `foo bar`. Nested items match the same way. When several " +
    "items share the text, DOC_TASK_AMBIGUOUS lists each as {blockId, nth, line}: pick one with --nth or --block. " +
    "An item already in the wanted state is left alone (changed: false). If the block changes between the read and " +
    "the write, the command re-reads once and retries.\n\n" +
    "Flags:\n" +
    "  --item text    the task's text, exactly as in `threa docs read` (required)\n" +
    "  --reason r     required; one line shown to people on the stream's timeline\n" +
    "  --uncheck      clear the box instead of ticking it\n" +
    "  --block blk_x  only look in this block\n" +
    "  --nth N        pick the Nth match (1-based, document order) among items with this text\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    item: { type: "string" },
    reason: { type: "string" },
    uncheck: { type: "boolean" },
    block: { type: "string" },
    nth: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const docId = positionals[0]
    if (!docId) throw new UsageError("docs check requires a <doc-id>")
    const item = stringFlag(values, "item")
    if (!item) throw new UsageError('docs check requires --item "text" (the task text after the box)')
    const reason = stringFlag(values, "reason")
    if (!reason) throw new UsageError("docs check requires --reason (one line shown on the stream's timeline)")
    const rawNth = stringFlag(values, "nth")
    if (rawNth !== undefined && !/^[1-9]\d*$/.test(rawNth)) {
      throw new UsageError("docs check --nth must be a whole number >= 1")
    }
    const nth = rawNth === undefined ? undefined : Number(rawNth)
    return checkDocTask(ctx.client, {
      docId,
      item,
      checked: values.uncheck !== true,
      reason,
      blockId: stringFlag(values, "block"),
      nth,
    })
  },
  render: (payload) => {
    const d = (payload as { data?: { changed?: boolean; blockId?: string; line?: string } }).data
    const prefix = d?.changed ? "updated" : "already in that state, no change"
    return `${prefix} (${d?.blockId ?? "?"}): ${d?.line?.trim() ?? ""}`
  },
}

const moveVerb: VerbSpec = {
  name: "move",
  summary: "Move a doc to another host stream or to the top level",
  usage: "threa docs move <doc-id> (--to <stream-ref> | --top-level [--visibility v])",
  help:
    "threa docs move <doc-id> (--to <stream-ref> | --top-level) [flags]\n\n" +
    "Move a doc to another stream; its content, history, child docs and threads come with it. --top-level lifts it out of " +
    "its host instead: it becomes like a channel, private unless --visibility says otherwise, with you as its " +
    "only member, and only a user key may lift it. Only the doc's creator or a " +
    "workspace admin can move it, so a bot key moves only docs its bot created. A 403 DOC_MOVE_FORBIDDEN means " +
    "the key's user or bot is neither; 400 " +
    "DOC_HOST_TYPE_INVALID or DOC_E2E_HOST_NOT_ALLOWED means the target cannot host docs. " +
    "400 DOC_MOVE_CYCLE means the target is the doc itself or a descendant.\n\n" +
    "Flags:\n" +
    "  --to ref        the new host: a stream_… id or #channel-slug\n" +
    "  --top-level     lift the doc out of its host\n" +
    "  --visibility v  private|public|guest_public, with --top-level only (default private)\n" +
    "  --json          print the envelope (the doc with its new hostStreamId)\n" +
    "  --help          show this help",
  options: {
    to: { type: "string" },
    "top-level": { type: "boolean" },
    visibility: { type: "string" },
  },
  run: async (ctx, positionals, values) => {
    const docId = positionals[0]
    if (!docId) throw new UsageError("docs move requires a <doc-id>")
    const to = stringFlag(values, "to")
    const topLevel = boolFlag(values, "top-level")
    if (Boolean(to) === Boolean(topLevel)) {
      throw new UsageError("docs move takes one of --to <stream-ref> or --top-level")
    }
    const visibility = enumFlag(values, "visibility", VISIBILITIES)
    if (to && visibility) {
      throw new UsageError("docs move --visibility is for --top-level; a hosted doc takes its stream's")
    }
    return moveDoc(ctx.client, ctx.resolver, { docId, toStreamRef: to ?? null, visibility })
  },
  render: (payload) => {
    const p = payload as { data?: { id?: string; hostStreamId?: string | null } }
    return `moved ${p.data?.id ?? "?"} to ${hostLabel(p.data?.hostStreamId)}`
  },
}

export const docsNoun: NounSpec = {
  name: "docs",
  summary: "List, read, create, edit, check tasks in, comment on, and move docs",
  verbs: [listVerb, readVerb, editVerb, checkVerb, createVerb, commentVerb, moveVerb],
}
