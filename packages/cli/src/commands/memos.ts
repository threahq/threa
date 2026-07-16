import { getMemo } from "../ops"
import { UsageError, type CommandSpec } from "../output"

export const memoCommand: CommandSpec = {
  name: "memo",
  summary: "Get a memo by id, with its source-message provenance",
  usage: "threa memo <id>",
  help:
    "threa memo <id>\n\n" +
    "Retrieve one memo by id, with its source stream and the source messages it was extracted from " +
    "(provenance). Find memos in the first place with `threa search --what memos`.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("memo requires a <id> (a memo_ id)")
    return getMemo(ctx.client, id)
  },
}
