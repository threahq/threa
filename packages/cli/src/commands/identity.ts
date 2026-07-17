import { whoami } from "../ops"
import type { CommandSpec } from "../output"

export const whoamiCommand: CommandSpec = {
  name: "whoami",
  summary: "Show the authenticated principal, API version, and the bound workspace",
  usage: "threa whoami",
  help:
    "threa whoami\n\n" +
    "Return the authenticated principal for the configured API key (user or bot), the resolved API version, " +
    "and the base URL and workspace this CLI is bound to. Use it to confirm the key works.\n\n" +
    "Flags:\n" +
    "  --json / -o json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: (ctx) => whoami(ctx.client, ctx.config),
  render: (payload) => {
    const p = payload as {
      principal?: { kind?: string; userId?: string; botId?: string }
      baseUrl?: string
      workspaceId?: string
    }
    const who = p.principal?.userId ?? p.principal?.botId ?? "?"
    return [
      `principal: ${p.principal?.kind ?? "?"} ${who}`,
      `workspace: ${p.workspaceId ?? "?"}`,
      `baseUrl:   ${p.baseUrl ?? "?"}`,
    ].join("\n")
  },
}
