import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettings } from "@threahq/types"
import type { Querier } from "../../db"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import { isValidIanaTimezone, monthRangeInTimezone } from "../../lib/temporal"

/** Type-checked against the interface so renaming the setting breaks the build (INV-33). */
const BILLING_TIMEZONE_KEY = "billingTimezone" satisfies keyof WorkspaceSettings

/**
 * The workspace's own timezone — the boundary its AI spend month is cut on.
 *
 * Unset falls to `"UTC"`, the code default, NOT the server's local zone: the
 * boundary money resets on must not move when the deploy region does.
 */
export async function resolveBillingTimezone(db: Querier, workspaceId: string): Promise<string> {
  const override = await WorkspaceSettingsRepository.findOverride(db, workspaceId, BILLING_TIMEZONE_KEY)
  const stored = typeof override?.value === "string" ? override.value : null
  // A stored zone is validated at write time; re-check rather than let a hand-
  // edited row throw on every AI call in the workspace.
  if (stored && isValidIanaTimezone(stored)) return stored
  return DEFAULT_WORKSPACE_SETTINGS.billingTimezone
}

/**
 * The month the budget is actually enforced over. This is the workspace's own
 * window, never the caller's `?tz=` lens — a viewer switching the dashboard to
 * their device zone changes which slice of history they read, not when their
 * money resets.
 */
export async function resolveBudgetMonthRange(db: Querier, workspaceId: string): Promise<{ start: Date; end: Date }> {
  return monthRangeInTimezone(await resolveBillingTimezone(db, workspaceId))
}
