import { applyLabel, listLabels, removeLabel } from "../ops"
import { stringFlag, UsageError, type CommandSpec } from "../output"

interface LabelRow {
  id?: string
  name?: string
  emoji?: string
}

export const labelsCommand: CommandSpec = {
  name: "labels",
  summary: "List this key actor's labels and assignments",
  usage: "threa labels",
  help:
    "threa labels [flags]\n\n" +
    "List this key actor's labels and their resource assignments. Every label is private to the actor the API " +
    "key acts as; you never see another actor's labels.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx) => listLabels(ctx.client),
  render: (payload) => {
    const p = payload as { data?: { labels?: LabelRow[] } }
    const rows = p.data?.labels ?? []
    return (
      rows.map((l) => `${l.id ?? "?"}  ${l.emoji ? `${l.emoji} ` : ""}${l.name ?? ""}`.trimEnd()).join("\n") ||
      "(no labels)"
    )
  },
}

export const labelCommand: CommandSpec = {
  name: "label",
  summary: "Attach a label to a stream by name (found-or-created, idempotent)",
  usage: "threa label <name> <stream-ref> [--color #RRGGBB] [--emoji e] [--description d]",
  help:
    "threa label <name> <stream-ref> [flags]\n\n" +
    "Attach a label to a stream, identifying the label by its name. The label is found-or-created for this key " +
    "actor and then assigned, so re-applying the same name is idempotent. Any appearance flag you supply " +
    "overwrites that field on the existing label everywhere it is used, not only at creation. <stream-ref> is a " +
    "stream_ id or #channel-slug.\n\n" +
    "Flags:\n" +
    "  --color #RRGGBB   set the label color\n" +
    "  --emoji e         set the label emoji\n" +
    "  --description d   set the label description\n" +
    "  --json            force JSON output\n" +
    "  --help            show this help",
  options: {
    color: { type: "string" },
    emoji: { type: "string" },
    description: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    const name = positionals[0]
    if (!name) throw new UsageError("label requires a <name>")
    const ref = positionals[1]
    if (!ref) throw new UsageError("label requires a <stream-ref> (a stream_ id or #channel-slug)")
    return applyLabel(ctx.client, ctx.resolver, {
      name,
      streamRef: ref,
      color: stringFlag(values, "color"),
      emoji: stringFlag(values, "emoji"),
      description: stringFlag(values, "description"),
    })
  },
  render: (payload) => {
    const label = (payload as { data?: { label?: LabelRow } }).data?.label
    return `labeled ${label?.name ?? "?"}`
  },
}

export const unlabelCommand: CommandSpec = {
  name: "unlabel",
  summary: "Remove this key actor's label assignment from a stream",
  usage: "threa unlabel <name> <stream-ref>",
  help:
    "threa unlabel <name> <stream-ref> [flags]\n\n" +
    "Remove this key actor's assignment of a label (identified by its name) from a stream. The label itself is " +
    "not deleted, only its assignment to this stream. <stream-ref> is a stream_ id or #channel-slug.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const name = positionals[0]
    if (!name) throw new UsageError("unlabel requires a <name>")
    const ref = positionals[1]
    if (!ref) throw new UsageError("unlabel requires a <stream-ref> (a stream_ id or #channel-slug)")
    return removeLabel(ctx.client, ctx.resolver, { name, streamRef: ref })
  },
  render: (payload) => {
    const p = payload as { name?: string; stream_id?: string }
    return `unlabeled ${p.name ?? "?"} from ${p.stream_id ?? "?"}`
  },
}
