import { getMemo } from "../ops"
import { UsageError, type NounSpec, type VerbSpec } from "../output"

const getVerb: VerbSpec = {
  name: "get",
  summary: "Get a memo by id, with its source-message provenance",
  usage: "threa memos get <id>",
  help:
    "threa memos get <id>\n\n" +
    "Retrieve one memo by id, with its source stream and the source messages it was extracted from " +
    "(provenance). Find memos in the first place with `threa search --what memos`.\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("memos get requires a <id> (a memo_ id)")
    return getMemo(ctx.client, id)
  },
}

export const memosNoun: NounSpec = {
  name: "memos",
  summary: "Get a memo by id",
  verbs: [getVerb],
}
