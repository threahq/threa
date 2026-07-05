/**
 * Classify Claude Code API-error lines into carry-on decisions.
 *
 * When a model call dies (quota, overload, network, policy), Claude Code
 * appends a synthetic assistant message to the session transcript with
 * `isApiErrorMessage: true` and the error as plain text. These are the real
 * shapes observed in local transcripts:
 *
 *   "You've hit your session limit · resets 10:20pm (Europe/Stockholm)"
 *   "You've hit your org's monthly spend limit · ask your admin to raise it …"
 *   "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
 *   "API Error: Overloaded"
 *   "API Error: 500 Internal server error. …"
 *   "API Error: Unable to connect to API (ConnectionRefused)"
 *
 * The provider-specific parsing lives HERE, in the extension — Threa only ever
 * sees the generic outcome (a held turn, a notice, a scheduled resume).
 */

export type QuotaSignalKind =
  /** Quota exhausted with a parseable reset time — schedule a resume. */
  | "quota-reset"
  /** Quota exhausted with no usable reset time (monthly/org limits) — cannot schedule. */
  | "quota-no-reset"
  /** Transient provider/network failure worth one short-delay retry. */
  | "transient"
  /** Not retryable (policy refusal, model access, prompt too long, …). */
  | "other"

export interface QuotaSignal {
  kind: QuotaSignalKind
  /** Absolute epoch ms of the quota reset; only for kind "quota-reset". */
  resetAt?: number
  /** The matched error text, trimmed, for notices and logs. */
  summary: string
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const

/**
 * "resets 10:20pm (Europe/Stockholm)" — optionally with a leading weekday
 * ("resets Tuesday 10:20pm (…)"), which longer limit windows use.
 */
const RESET_RE = /resets\s+(?:([A-Za-z]+day)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i

function zonedFields(timestamp: number, timeZone: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(timestamp)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase() as (typeof WEEKDAYS)[number]),
  }
}

/** Epoch ms of wall-clock (y, m, d, hh, mm) in `timeZone`, via guess-and-correct (two passes cover DST edges). */
function zonedTimestamp(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  let guess = Date.UTC(y, m - 1, d, hh, mm)
  for (let pass = 0; pass < 2; pass++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(guess)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0")
    const rendered = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"))
    const target = Date.UTC(y, m - 1, d, hh, mm)
    if (rendered === target) return guess
    guess += target - rendered
  }
  return guess
}

/**
 * Resolve "resets <time> (<tz>)" to the next matching instant after `now`.
 * Returns undefined when the timezone is unknown or nothing matches within a
 * week — the caller then treats the signal as unschedulable rather than
 * guessing.
 */
export function parseResetTime(text: string, now: number): number | undefined {
  const match = RESET_RE.exec(text)
  if (!match) return undefined
  const [, weekdayRaw, hourRaw, minuteRaw, meridiem, timeZone] = match
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
  } catch {
    return undefined
  }
  const hour12 = Number(hourRaw)
  if (hour12 < 1 || hour12 > 12) return undefined
  const hh = (hour12 % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0)
  const mm = minuteRaw ? Number(minuteRaw) : 0
  const wantedWeekday = weekdayRaw ? WEEKDAYS.indexOf(weekdayRaw.toLowerCase() as (typeof WEEKDAYS)[number]) : -1
  if (weekdayRaw && wantedWeekday === -1) return undefined

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    // Anchor each candidate day at noon UTC so date arithmetic never slips a
    // calendar day across the tz offset.
    const anchor = zonedFields(now + dayOffset * 86_400_000, timeZone!)
    if (wantedWeekday !== -1 && anchor.weekday !== wantedWeekday) continue
    const candidate = zonedTimestamp(anchor.y, anchor.m, anchor.d, hh, mm, timeZone!)
    // A reset that just passed (within a minute) means the quota is already
    // back — resume now rather than waiting a full day/week for the next slot.
    if (candidate >= now - 60_000) return candidate
  }
  return undefined
}

export function classifyApiErrorText(text: string, now: number = Date.now()): QuotaSignal {
  const summary = text.trim().replace(/\s+/g, " ").slice(0, 300)
  const lower = summary.toLowerCase()

  const isUsageLimit =
    /\b(?:you'?ve hit your|reached your).{0,40}\blimit\b/i.test(summary) || lower.includes("usage limit reached")
  if (isUsageLimit) {
    const resetAt = parseResetTime(summary, now)
    if (resetAt !== undefined) return { kind: "quota-reset", resetAt, summary }
    return { kind: "quota-no-reset", summary }
  }

  if (
    lower.includes("temporarily limiting requests") ||
    lower.includes("rate limited") ||
    lower.includes("overloaded") ||
    /api error: 5\d\d/.test(lower) ||
    lower.includes("internal server error") ||
    lower.includes("unable to connect") ||
    lower.includes("socket connection was closed") ||
    lower.includes("connectionrefused")
  ) {
    return { kind: "transient", summary }
  }

  return { kind: "other", summary }
}
