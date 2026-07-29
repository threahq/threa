import { z } from "zod"
import {
  AGENT_SETTABLE_PREFERENCE_KEYS,
  AgentStepTypes,
  AgentToolNames,
  StreamTypes,
  TOOL_CATEGORIES_BY_NAME,
  type AgentSettablePreferences,
  type AgentSessionRerunCause,
  type StreamType,
} from "@threa/types"
import { updatePreferencesSchema } from "../../user-preferences"
import { logger } from "../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { UpdateUserSettingsToolDeps } from "./tool-deps"

/**
 * Derived from the API's own schema rather than restated, so a bound or enum
 * that changes there changes here too (INV-35). The pick is the allowlist —
 * everything else the settings page can edit is simply not expressible.
 */
const UpdateUserSettingsSchema = updatePreferencesSchema
  .pick(Object.fromEntries(AGENT_SETTABLE_PREFERENCE_KEYS.map((key) => [key, true])) as never)
  .refine((patch) => Object.values(patch as Record<string, unknown>).some((value) => value !== undefined), {
    message: "Provide at least one setting to change",
  })

export type UpdateUserSettingsInput = AgentSettablePreferences

const PROMPT_BLOCK = `## Changing the user's settings

You can change some of this user's own settings with \`update_user_settings\` — only in their scratchpads, because settings are personal. Pass only the keys that should change.

- \`theme\` — \`light\` | \`dark\` | \`system\`
- \`messageDisplay\` — \`compact\` | \`comfortable\`
- \`dateFormat\` — \`YYYY-MM-DD\` | \`DD/MM/YYYY\` | \`MM/DD/YYYY\`
- \`timeFormat\` — \`24h\` | \`12h\`
- \`timezone\` — IANA name, e.g. \`Europe/Stockholm\`
- \`language\` — BCP-47 code, e.g. \`sv\`
- \`notificationLevel\` — \`all\` | \`mentions\` | \`none\`
- \`unreadOpenPosition\` — \`latest\` (open at the newest message) | \`marker\` (open at the first unread)
- \`workSchedule\` — the user's working week and hours, or \`null\` to fall back to the workspace default

Rules that matter:
- **Only change what they asked for.** A request to switch theme is not permission to also fix their timezone, however obviously wrong it looks. Mention the other thing instead and let them decide.
- **A statement is not a request.** "it's midnight here" is information; "put me on CET" is a request.
- **Say what you changed**, with the values, so it is never a surprise.
- If a change is refused pending their approval, do not retry it — tell them what you wanted to do and why, and ask.
- Anything not listed above — your own scratchpad instructions, which companion runs, keyboard shortcuts, voice settings — you cannot change. Point them at Settings.`

/**
 * Whether this turn may offer `update_user_settings`.
 *
 * Three independent conditions, each for its own reason — extracted so the rule
 * is one reviewable expression rather than a condition buried in the middle of
 * turn assembly:
 *
 * - The effective ROOT must be a scratchpad the INVOKING USER OWNS. "Scratchpad"
 *   alone is not enough: adding someone to a thread inserts them into the root
 *   scratchpad too, so a second person can legitimately be a member of someone
 *   else's scratchpad and trigger a turn there. Settings are personal — they
 *   are editable in your own space, not merely in a space shaped like one. A
 *   thread inherits its root's surface, the same rule access uses (INV-62).
 * - A human must have triggered the turn. A catch-up or fired follow-up has no
 *   user whose settings these are.
 * - The stream must not be sealed. The enclave runs its own loop and cannot
 *   reach the preferences service, so offering the tool there would advertise a
 *   capability that cannot work.
 */
export function canOfferUserSettings(params: {
  rootStreamType: StreamType | null
  rootStreamCreatedBy: string | null
  invokingUserId: string | undefined
  e2eEnabled: boolean
  /**
   * Why this turn is a supersede rerun, when it is one. A
   * `referenced_message_edited` rerun is triggered by an edit to a message the
   * ORIGINAL session merely referenced — so the person who caused this turn is
   * not the principal it runs as, while the supersede prompt presents their
   * edited text as authoritative intent. Whoever's edit fired it must not be
   * able to steer a durable write against the original invoker's account.
   */
  rerunCause?: AgentSessionRerunCause
}): boolean {
  if (params.rerunCause === "referenced_message_edited") return false
  return (
    params.rootStreamType === StreamTypes.SCRATCHPAD &&
    Boolean(params.invokingUserId) &&
    params.rootStreamCreatedBy === params.invokingUserId &&
    !params.e2eEnabled
  )
}

/**
 * A scalar preference rendered for the trace's `before → after` diff, or null
 * when the value has no honest one-line form.
 *
 * `workSchedule` is the one structured agent-settable key: serialized it runs
 * past 200 characters, so both sides truncate to the same prefix and a real
 * change renders as no change at all. A diff that says nothing moved is worse
 * than no diff, so a structured value declares its key and stops there.
 */
function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return null
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Change the invoking user's own preferences.
 *
 * The target user is bound at construction, never a tool parameter: a model
 * that hallucinated a user id would have nowhere to put it, so a cross-user
 * write is impossible by shape rather than by a validation branch that could be
 * forgotten. Availability is narrowed the same way — the deps only exist on a
 * scratchpad turn a human triggered (see `buildToolSet`), so the tool is absent
 * rather than refusing at call time.
 *
 * Tier 2 (`TOOL_TIERS_BY_NAME`): the guardian reviews the conversation before
 * any of this runs.
 */
export function createUpdateUserSettingsTool(deps: UpdateUserSettingsToolDeps) {
  return defineAgentTool({
    name: AgentToolNames.UPDATE_USER_SETTINGS,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.UPDATE_USER_SETTINGS],
    description:
      "Change this user's own settings — theme, message display, date/time format, timezone, language, notification level, where an unread stream opens, and their working schedule. Pass only the keys that should change. Only available in the user's own scratchpads. Change only what they asked for, and tell them what you changed.",
    inputSchema: UpdateUserSettingsSchema,
    promptBlock: PROMPT_BLOCK,

    execute: async (rawInput): Promise<AgentToolResult> => {
      // Re-validated HERE, not trusted from upstream. The runtime hands
      // `execute` whatever the provider returned as the call's arguments
      // (`input: tc.input`, typed `unknown`), so a call the SDK rejected — or
      // one from any future path that skips schema enforcement — would arrive
      // with keys this tool must never write. `updatePreferences` accepts
      // `scratchpadCustomPrompt` and `defaultCompanionPersonaId` happily, so
      // the allowlist has to be authoritative at the point of the write, the
      // same way the target user is bound at construction rather than trusted
      // from the model.
      const parsed = UpdateUserSettingsSchema.safeParse(rawInput)
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, "update_user_settings rejected an invalid patch")
        return {
          output: JSON.stringify({
            ok: false,
            error: `Those settings aren't valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
          }),
        }
      }

      const patch = parsed.data as AgentSettablePreferences
      const changedKeys = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined)

      try {
        const { before, after } = await deps.updateSettings(patch)
        const applied = Object.fromEntries(
          changedKeys.map((key) => [key, (after as unknown as Record<string, unknown>)[key]])
        )
        const previous = Object.fromEntries(
          changedKeys.map((key) => [key, (before as unknown as Record<string, unknown>)[key]])
        )
        return { output: JSON.stringify({ ok: true, applied, previous }) }
      } catch (error) {
        logger.error({ err: error, changedKeys }, "update_user_settings failed")
        return {
          output: JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : "Could not update settings",
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input, result) => {
        const parsed = JSON.parse(result.output) as { ok: boolean; applied?: Record<string, unknown>; error?: string }
        if (!parsed.ok) return `Couldn't change settings: ${parsed.error ?? "unknown error"}`
        const applied = parsed.applied ?? (input as Record<string, unknown>)
        const pairs = Object.entries(applied).map(([key, value]) => `${key} → ${JSON.stringify(value)}`)
        return `Changed ${pairs.join(", ")}`
      },
      effects: (_input, result) => {
        const parsed = JSON.parse(result.output) as {
          ok: boolean
          applied?: Record<string, unknown>
          previous?: Record<string, unknown>
        }
        if (!parsed.ok || !parsed.applied) return []
        const previous = parsed.previous ?? {}
        return Object.entries(parsed.applied)
          .filter(([key, value]) => !sameValue(previous[key], value))
          .map(([key, value]) => {
            const before = displayValue(previous[key])
            const after = displayValue(value)
            return {
              kind: "settings" as const,
              target: key,
              // Both or neither: a one-sided diff reads as "was empty, now X",
              // which is a different claim from "changed, shown elsewhere".
              ...(before !== null && after !== null ? { before, after } : {}),
            }
          })
      },
    },
  })
}

/** Exported for the tool-set test — the schema the model actually sees. */
export const updateUserSettingsSchema: z.ZodTypeAny = UpdateUserSettingsSchema
