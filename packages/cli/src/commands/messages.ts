import { findMessagesByMetadata } from "../ops"
import { intFlag, kvPairs, stringFlag, UsageError, type CommandSpec } from "../output"

export const findByMetadataCommand: CommandSpec = {
  name: "find-by-metadata",
  summary: "Find messages whose metadata contains every given key=value pair",
  usage: "threa find-by-metadata k=v [k=v ...] [--stream ref] [--limit n]",
  help:
    "threa find-by-metadata k=v [k=v ...] [flags]\n\n" +
    "Find non-deleted messages whose metadata contains every given key=value pair (exact AND-containment, not " +
    "text search). Use it to dedup by an external reference you stamped at send time, e.g. github.pr=org/repo#42.\n\n" +
    "Flags:\n" +
    "  --stream ref   narrow to a stream (stream_ id or #slug)\n" +
    "  --limit n      max results, <= 100 (default 20)\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    stream: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, positionals, values) => {
    if (positionals.length === 0) {
      throw new UsageError("find-by-metadata requires at least one k=v pair")
    }
    return findMessagesByMetadata(ctx.client, ctx.resolver, {
      metadata: kvPairs(positionals),
      streamRef: stringFlag(values, "stream"),
      limit: intFlag(values, "limit"),
    })
  },
  render: (payload) => {
    const p = payload as { data?: Array<{ id?: string; streamId?: string; author?: { name?: string } }> }
    const rows = p.data ?? []
    return (
      rows.map((m) => `${m.id ?? "?"}  ${m.streamId ?? "?"}  ${m.author?.name ?? ""}`.trimEnd()).join("\n") ||
      "(no matches)"
    )
  },
}
