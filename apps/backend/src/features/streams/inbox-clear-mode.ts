import type { Querier } from "../../db"
import { UserPreferencesRepository } from "../user-preferences"
import { DEFAULT_USER_PREFERENCES, type InboxClearMode } from "@threahq/types"

const INBOX_CLEAR_MODE_KEY = "inboxClearMode" satisfies keyof typeof DEFAULT_USER_PREFERENCES

/**
 * The user's Inbox clear mode, read directly from the override store (no
 * workspace scoping — preference overrides are keyed by user id alone, same
 * as `resolveDefaultPersona`'s single-key reads). Cheaper than merging the
 * whole preference object when a hold site needs only this one key (INV-27).
 */
export async function resolveInboxClearMode(db: Querier, userId: string): Promise<InboxClearMode> {
  const override = await UserPreferencesRepository.findOverride(db, userId, INBOX_CLEAR_MODE_KEY)
  return (override?.value as InboxClearMode | undefined) ?? DEFAULT_USER_PREFERENCES.inboxClearMode
}
