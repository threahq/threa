import type { DateFormat, TimeFormat } from "@threa/types"

export interface TemporalContext {
  /** Current time in ISO format at invocation */
  currentTime: string
  /** Invoking user's timezone (IANA identifier, e.g., "America/New_York") */
  timezone: string
  /** UTC offset string (e.g., "UTC-5") */
  utcOffset: string
  /** User's preferred date format */
  dateFormat: DateFormat
  /** User's preferred time format */
  timeFormat: TimeFormat
}

export interface ParticipantTemporal {
  id: string
  name: string
  timezone: string
  utcOffset: string
}

/**
 * Get the UTC offset string for a timezone (e.g., "UTC+1", "UTC-5").
 */
export function getUtcOffset(timezone: string, date: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    })

    const parts = formatter.formatToParts(date)
    const offsetPart = parts.find((p) => p.type === "timeZoneName")

    if (offsetPart?.value) {
      const offset = offsetPart.value.replace("GMT", "UTC")
      if (offset === "UTC") return "UTC+0"
      return offset
    }
  } catch {
    // Invalid timezone, fall back to UTC
  }
  return "UTC+0"
}

/**
 * Parse UTC offset string to minutes (e.g., "UTC+1" -> 60, "UTC-5:30" -> -330).
 */
export function parseUtcOffsetMinutes(offset: string): number {
  const match = offset.match(/UTC([+-])(\d+)(?::(\d+))?/)
  if (!match) return 0

  const sign = match[1] === "+" ? 1 : -1
  const hours = parseInt(match[2], 10)
  const minutes = parseInt(match[3] ?? "0", 10)

  return sign * (hours * 60 + minutes)
}

export function hasSameOffset(offsets: string[]): boolean {
  if (offsets.length === 0) return true

  const firstMinutes = parseUtcOffsetMinutes(offsets[0])
  return offsets.every((o) => parseUtcOffsetMinutes(o) === firstMinutes)
}

/**
 * Format a time according to user preferences.
 * Returns format like "14:30" (24h) or "2:30 PM" (12h).
 */
export function formatTime(date: Date, timezone: string, format: TimeFormat): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: format === "12h",
  }

  return new Intl.DateTimeFormat("en-US", options).format(date)
}

export function formatDate(date: Date, timezone: string, format: DateFormat): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }

  const formatter = new Intl.DateTimeFormat("en-US", options)
  const parts = formatter.formatToParts(date)

  const year = parts.find((p) => p.type === "year")?.value ?? ""
  const month = parts.find((p) => p.type === "month")?.value ?? ""
  const day = parts.find((p) => p.type === "day")?.value ?? ""

  switch (format) {
    case "YYYY-MM-DD":
      return `${year}-${month}-${day}`
    case "DD/MM/YYYY":
      return `${day}/${month}/${year}`
    case "MM/DD/YYYY":
      return `${month}/${day}/${year}`
    default:
      return `${year}-${month}-${day}`
  }
}

/** Date key in a timezone, for grouping. */
export function getDateKey(date: Date, timezone: string): string {
  return formatDate(date, timezone, "YYYY-MM-DD")
}

export function formatCurrentTime(
  date: Date,
  timezone: string,
  dateFormat: DateFormat,
  timeFormat: TimeFormat
): string {
  const dateStr = formatDate(date, timezone, dateFormat)
  const timeStr = formatTime(date, timezone, timeFormat)
  return `${dateStr} ${timeStr}`
}

/**
 * Build temporal context section for system prompt.
 *
 * For same-offset participants: simple format without timezone indicators.
 * For different-offset participants: shows participant offsets once.
 */
export function buildTemporalPromptSection(temporal: TemporalContext, participants?: ParticipantTemporal[]): string {
  const currentTimeFormatted = formatCurrentTime(
    new Date(temporal.currentTime),
    temporal.timezone,
    temporal.dateFormat,
    temporal.timeFormat
  )

  const hasMixedTimezones =
    participants &&
    participants.length > 0 &&
    !hasSameOffset([temporal.utcOffset, ...participants.map((p) => p.utcOffset)])

  const formatExample = temporal.timeFormat === "12h" ? "2:30 PM" : "14:30"
  const formatInstruction = `When referencing times, use ${temporal.timeFormat === "12h" ? "12-hour" : "24-hour"} format (e.g., ${formatExample}).`
  const timestampInstruction = `User messages are prefixed with their send time, e.g., (${formatExample}). Do not include timestamps in your responses.`
  const groundingInstruction =
    "Treat the current time above as the invocation-time definition of now for relative terms like today, tomorrow, yesterday, this week, recently, latest, and current. It is not your training cutoff date and not the stream creation date. Resolve relative times silently while reasoning; mention the current time only when the user asks for it."

  if (hasMixedTimezones && participants) {
    // Different offsets: state offsets once in system prompt
    let section = `\n\n## Current Time\n\n`
    section += `Current time: ${currentTimeFormatted} (${temporal.utcOffset}, canonical)\n\n`
    section += `Participant timezones:\n`

    for (const p of participants) {
      if (p.utcOffset !== temporal.utcOffset) {
        const offsetDiff = getOffsetDifference(temporal.utcOffset, p.utcOffset)
        section += `- ${p.name}: ${p.utcOffset} (${offsetDiff})\n`
      }
    }

    section += `\n${groundingInstruction}\n${formatInstruction}\n${timestampInstruction}`
    return section
  }

  // Same offset: simple format
  return `\n\n## Current Time\n\nCurrent time: ${currentTimeFormatted}\n\n${groundingInstruction}\n${formatInstruction}\n${timestampInstruction}`
}

/**
 * Get human-readable offset difference (e.g., "2h ahead", "3h behind").
 */
function getOffsetDifference(canonicalOffset: string, otherOffset: string): string {
  const canonicalMinutes = parseUtcOffsetMinutes(canonicalOffset)
  const otherMinutes = parseUtcOffsetMinutes(otherOffset)
  const diffMinutes = otherMinutes - canonicalMinutes

  if (diffMinutes === 0) return "same time"

  const hours = Math.abs(diffMinutes) / 60
  const direction = diffMinutes > 0 ? "ahead" : "behind"

  if (hours === Math.floor(hours)) {
    return `${hours}h ${direction}`
  }
  // Handle half-hour offsets
  return `${hours.toFixed(1)}h ${direction}`
}

/**
 * Format a date as a relative time string (e.g., "2 hours ago", "yesterday").
 * Used for displaying message timestamps in a human-friendly way.
 */
export function formatRelativeDate(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 30) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  }

  if (diffDays > 0) {
    return diffDays === 1 ? "yesterday" : `${diffDays} days ago`
  }

  if (diffHours > 0) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`
  }

  if (diffMinutes > 0) {
    return diffMinutes === 1 ? "1 minute ago" : `${diffMinutes} minutes ago`
  }

  return "just now"
}
