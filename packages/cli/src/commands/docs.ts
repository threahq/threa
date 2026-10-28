import { commentOnDoc, createDoc, editDoc, listDocs, readDoc } from "../ops"
import { arrayFlag, stringFlag, UsageError, type NounSpec, type VerbSpec } from "../output"

interface DocRow {
  id?: string
  title?: string | null
  seq?: number
  markdown?: string
  touchedBlockIds?: string[]
}

const listVerb: VerbSpec = {
  name: "list",
  summary: "List the active docs a stream hosts, newest first",
  usage: "threa docs list <stream-ref>",
  help:
    "threa docs list <stream-ref> [flags]\n\n" +
    "List the active docs hosted by a stream, newest first. Each row is the doc id, its title (or (untitled)), " +
    "and its seq (the edit counter). <stream-ref> is a stream_ id or #channel-slug.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const ref = positionals[0]
    if (!ref) throw new UsageError("docs list requires a <stream-ref> (a stream_ id or #channel-slug)")
    return listDocs(ctx.client, ctx.resolver, { streamRef: ref })
  },
  render: (payload) => {
    const rows = (payload as { data?: DocRow[] }).data ?? []
    return rows.map((d) => `${d.id ?? "?"}  ${d.title || "(untitled)"}  ${d.seq ?? "?"}`).join("\n") || "(no docs)"
  },
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
  summary: "Create a doc hosted by a stream",
  usage: "threa docs create <stream-ref> [--title t] [--body text | --body -] [--reason r]",
  help:
    "threa docs create <stream-ref> [flags]\n\n" +
    "Create a doc hosted by a stream. <stream-ref> is a stream_ id or #channel-slug. The body is markdown; " +
    "`--body -` reads it from stdin. --reason is required with --body.\n\n" +
    "Flags:\n" +
    "  --title t      doc title\n" +
    "  --body text    initial markdown, or - to read stdin\n" +
    "  --reason r     one line shown to people on the stream's timeline (required with --body)\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    title: { type: "string" },
    body: { type: "string" },
    reason: { type: "string" },
  },
  run: async (ctx, positionals, values) => {
    const ref = positionals[0]
    if (!ref) throw new UsageError("docs create requires a <stream-ref> (a stream_ id or #channel-slug)")
    const rawBody = stringFlag(values, "body")
    const reason = stringFlag(values, "reason")
    if (rawBody !== undefined && !reason) throw new UsageError("docs create --body requires --reason")
    const markdown = rawBody === "-" ? await ctx.readStdin() : rawBody
    return createDoc(ctx.client, ctx.resolver, { streamRef: ref, title: stringFlag(values, "title"), markdown, reason })
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

export const docsNoun: NounSpec = {
  name: "docs",
  summary: "List, read, create, edit, and comment on docs hosted by streams",
  verbs: [listVerb, readVerb, editVerb, createVerb, commentVerb],
}
