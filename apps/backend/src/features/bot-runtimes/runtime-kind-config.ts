/**
 * Per-runtime-kind dispatch policy for the active-scratchpad path.
 *
 * Pi and the Claude Code channel drive long-lived local sessions, so their
 * active-scratchpad turns must be pinned to an explicit session link (created
 * via Pi's `/remote-control` flow or the Claude Code channel's startup) —
 * without one we post a notice telling the user how to link. A `custom`
 * runtime (anything built on the public SDK) may link a scratchpad and then
 * gets targeted turns and session control; without a link its invocations
 * dispatch untargeted, like the kinds that never link at all, so an external
 * bot that only answers mentions keeps working unchanged.
 */

import type { BotRuntimeKind } from "@threahq/types"

export type BotRuntimeKindConfig =
  | {
      sessionLinking: "required"
      /** Markdown for the system notice posted when no active session link exists. */
      missingSessionLinkNotice: (botName: string) => string
    }
  | { sessionLinking: "optional" }
  | { sessionLinking: "none" }

const BOT_RUNTIME_KIND_CONFIGS: Record<BotRuntimeKind, BotRuntimeKindConfig> = {
  "pi-local": {
    sessionLinking: "required",
    missingSessionLinkNotice: (botName) =>
      `**${botName} is not linked to this scratchpad.** Run \`/remote-control\` in Pi to link a session.`,
  },
  hermes: { sessionLinking: "none" },
  openclaw: { sessionLinking: "none" },
  "claude-code-channel": {
    sessionLinking: "required",
    missingSessionLinkNotice: (botName) =>
      `**${botName} is not linked to this scratchpad.** Start Claude Code with the Threa channel (\`claude --channels …\`) to link a session.`,
  },
  custom: { sessionLinking: "optional" },
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
