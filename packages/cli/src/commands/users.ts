import { listUsers } from "../ops"
import { cursorFooter, intFlag, stringFlag, type CommandSpec } from "../output"

export const usersCommand: CommandSpec = {
  name: "users",
  summary: "List workspace users",
  usage: "threa users [--query q] [--after cursor] [--limit n]",
  help:
    "threa users [flags]\n\n" +
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
  render: (payload) => {
    const p = payload as {
      data?: Array<{ id?: string; name?: string; slug?: string; email?: string }>
      hasMore?: boolean
      cursor?: string | null
    }
    const rows = p.data ?? []
    const lines = rows.map((u) =>
      `${u.id ?? "?"}  ${u.name ?? "?"}  ${u.slug ? `@${u.slug}` : ""}  ${u.email ?? ""}`.trimEnd()
    )
    lines.push(...cursorFooter(p, "after"))
    return lines.join("\n") || "(no users)"
  },
}
