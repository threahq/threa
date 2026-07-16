import { listUsers } from "../ops"
import { cursorFooter, intFlag, renderList, stringFlag, type NounSpec, type VerbSpec } from "../output"

const listVerb: VerbSpec = {
  name: "list",
  summary: "List workspace users",
  usage: "threa users list [--query q] [--after cursor] [--limit n]",
  help:
    "threa users list [flags]\n\n" +
    "List users in this workspace. --query matches on name or email (not slug).\n\n" +
    "Flags:\n" +
    "  --query q    text match on name or email\n" +
    "  --after c    pagination cursor from a previous response\n" +
    "  --limit n    max results, <= 200 (default 50)\n" +
    "  --json       force JSON output\n" +
    "  --help       show this help",
  options: {
    query: { type: "string" },
    after: { type: "string" },
    limit: { type: "string" },
  },
  run: (ctx, _positionals, values) =>
    listUsers(ctx.client, {
      query: stringFlag(values, "query"),
      after: stringFlag(values, "after"),
      limit: intFlag(values, "limit"),
    }),
  render: (payload) =>
    renderList<{ id?: string; name?: string; slug?: string; email?: string }>(
      payload,
      (u) => `${u.id ?? "?"}  ${u.name ?? "?"}  ${u.slug ? `@${u.slug}` : ""}  ${u.email ?? ""}`.trimEnd(),
      { empty: "(no users)", cursorFlag: "after" }
    ),
}

export const usersNoun: NounSpec = {
  name: "users",
  summary: "List workspace users",
  verbs: [listVerb],
}
