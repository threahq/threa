/**
 * Per-runtime-kind dispatch policy for the active-scratchpad path.
 *
 * Pi drives long-lived local sessions, so its active-scratchpad turns must be
 * pinned to an explicit session link (created via Pi's `/remote-control`
 * flow) — without one we post a notice telling the user how to link. Other
 * kinds never create session links; their invocations dispatch untargeted and
 * any live instance of the bot may claim them.
 */

import type { BotRuntimeKind } from "@threa/types"

export type BotRuntimeKindConfig =
  | {
      sessionLinking: "required"
      /** Markdown for the system notice posted when no active session link exists. */
      missingSessionLinkNotice: (botName: string) => string
    }
  | { sessionLinking: "none" }

const BOT_RUNTIME_KIND_CONFIGS: Record<BotRuntimeKind, BotRuntimeKindConfig> = {
  "pi-local": {
    sessionLinking: "required",
    missingSessionLinkNotice: (botName) =>
      `**${botName} is not linked to this scratchpad.** Run \`/remote-control\` in Pi to link a session.`,
  },
  hermes: { sessionLinking: "none" },
  openclaw: { sessionLinking: "none" },
  "claude-code-channel": { sessionLinking: "none" },
  custom: { sessionLinking: "none" },
}

/**
 * Null kind (no runtime instance ever seen for the bot) resolves to the
 * pi-local config: only Pi's link flow can make a bot the active scratchpad
 * actor today, so a presence-less active actor is a Pi straggler. Matches the
 * `runtimeKind ?? PI_LOCAL` default the public API already uses.
 */
export function resolveRuntimeKindConfig(kind: BotRuntimeKind | null): BotRuntimeKindConfig {
  return BOT_RUNTIME_KIND_CONFIGS[kind ?? "pi-local"]
}
