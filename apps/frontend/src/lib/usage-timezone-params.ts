/**
 * One source of truth (INV-33) for the AI usage dashboard's reporting-timezone
 * URL state — every writer and reader of the param goes through here.
 *
 * The param carries the *mode*, not a zone: `?zone=workspace` keeps tracking the
 * workspace setting after an admin changes it, where a frozen IANA string would
 * go stale. Deliberately not named `tz` — the API's own `?tz=` takes a resolved
 * IANA zone (`?tz=Asia/Tokyo`), and one name over two value spaces is a trap.
 */
export const USAGE_ZONE_PARAM = "zone"

export const USAGE_TIMEZONE_MODES = ["device", "workspace"] as const

/** Which timezone the dashboard draws its day and month lines in. */
export type UsageTimezoneMode = (typeof USAGE_TIMEZONE_MODES)[number]

/** Device is the default, so it is the absent-param state rather than a value. */
export const DEFAULT_USAGE_TIMEZONE_MODE: UsageTimezoneMode = "device"

export function parseUsageTimezoneMode(raw: string | null): UsageTimezoneMode {
  return USAGE_TIMEZONE_MODES.includes(raw as UsageTimezoneMode)
    ? (raw as UsageTimezoneMode)
    : DEFAULT_USAGE_TIMEZONE_MODE
}

/** Apply a mode to a param set, dropping the param entirely for the default. */
export function writeUsageTimezoneMode(params: URLSearchParams, mode: UsageTimezoneMode): URLSearchParams {
  const next = new URLSearchParams(params)
  if (mode === DEFAULT_USAGE_TIMEZONE_MODE) next.delete(USAGE_ZONE_PARAM)
  else next.set(USAGE_ZONE_PARAM, mode)
  return next
}
