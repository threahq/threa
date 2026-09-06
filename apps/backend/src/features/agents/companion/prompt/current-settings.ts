import { AGENT_SETTABLE_PREFERENCE_KEYS, type UserPreferences } from "@threahq/types"

/**
 * The user's current values for every setting the agent can change.
 *
 * Present so "make it dark" doesn't cost a read tool first — the preferences
 * are already loaded at context time, so this is free. It is also what makes
 * "you're already on dark" answerable without a call.
 *
 * Rendered only when `update_user_settings` is actually in the toolset:
 * elsewhere these values are noise the model can neither act on nor was asked
 * about, and they'd cost tokens on every turn in every channel.
 */
export function buildCurrentSettingsSection(preferences: UserPreferences): string {
  const lines = AGENT_SETTABLE_PREFERENCE_KEYS.map((key) => {
    const value = preferences[key]
    return `- ${key}: ${value === null || value === undefined ? "(unset — inherits the workspace default)" : JSON.stringify(value)}`
  })

  return `

## Their Current Settings

These are the settings you can change for this user, as they stand right now. Use them to answer questions about their setup, and to avoid "changing" something to the value it already has.

${lines.join("\n")}`
}
