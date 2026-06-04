import { z } from "zod"
import {
  STREAM_TYPES,
  VISIBILITY_OPTIONS,
  COMPANION_MODES,
  CONTENT_FORMATS,
  AUTHOR_TYPES,
  NOTIFICATION_LEVELS,
  parseHHMM,
  isStatusContentful,
  STATUS_TEXT_MAX_LENGTH,
  MAX_STATUS_PRESETS,
} from "@threa/types"

export const streamTypeSchema = z.enum(STREAM_TYPES)
export const visibilitySchema = z.enum(VISIBILITY_OPTIONS)
export const companionModeSchema = z.enum(COMPANION_MODES)
export const contentFormatSchema = z.enum(CONTENT_FORMATS)
export const authorTypeSchema = z.enum(AUTHOR_TYPES)
export const notificationLevelSchema = z.enum(NOTIFICATION_LEVELS)

// Working schedule — shared by user-preferences (per-user override) and
// workspace-settings (workspace default) so both validate identically (INV-35).
// A shift is a wall-clock "HH:MM" range that must not end before it starts.
const hhmmSchema = z.string().refine((v) => parseHHMM(v) !== null, "Must be HH:MM (24h)")
const shiftIntervalSchema = z
  .object({ start: hhmmSchema, end: hhmmSchema })
  .refine((s) => parseHHMM(s.end)! > parseHHMM(s.start)!, { message: "Shift end must be after start" })

// Every weekday key (0–6) maps to an array of shifts; empty array = day off.
// Cap shifts per day so a client can't store an unbounded blob. Keys are listed
// explicitly so the inferred output matches Record<Weekday, ShiftInterval[]>.
const dayShiftsSchema = z.array(shiftIntervalSchema).max(6)
export const workScheduleSchema = z.object({
  days: z.object({
    0: dayShiftsSchema,
    1: dayShiftsSchema,
    2: dayShiftsSchema,
    3: dayShiftsSchema,
    4: dayShiftsSchema,
    5: dayShiftsSchema,
    6: dayShiftsSchema,
  }),
})

// BIK registration — a runtime's per-session X25519 public key (base64, 32
// bytes) and the short id used as `recipient_key_id` when a stream's SSK is
// wrapped to this bot. A 32-byte key is always exactly 44 base64 chars ending
// in one `=`, so an explicit length + base64 regex pins it precisely — and,
// unlike a `.refine`, both constraints serialize into the generated OpenAPI so
// the published contract matches runtime validation (no empty/any-length key).
// Lives here — a zero-feature-dep leaf — so the WS `bot:hello` and HTTP
// presence schemas share one definition (INV-31) without importing across the
// cyclic public-api ↔ bot-runtimes edge.
const E2E_PUBLIC_KEY_BASE64_LEN = 44
export const botIdentityKeyFields = {
  publicKey: z
    .string()
    .length(E2E_PUBLIC_KEY_BASE64_LEN)
    .regex(/^[A-Za-z0-9+/]{43}=$/, "publicKey must be a 32-byte X25519 key (base64)")
    .optional(),
  publicKeyId: z.string().min(1).max(128).optional(),
} as const

// publicKey and publicKeyId are addressing partners — a wrap needs both — so
// reject a half-registered key rather than silently storing an unusable one.
export function bothOrNeitherBotIdentityKey(v: { publicKey?: string; publicKeyId?: string }): boolean {
  return (v.publicKey === undefined) === (v.publicKeyId === undefined)
}

// User statuses — shared by the set-status endpoint, workspace-settings
// (workspace default presets), and user-preferences (per-user presets) so a
// status preset validates identically wherever it is stored (INV-35).
// `emoji` is a shortcode (no colons); `defaultDuration` mirrors the scheduling
// reminder presets. A null duration means "indefinite".
export const statusDurationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("duration"),
    minutes: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60),
  }),
  z.object({
    kind: z.literal("calendar"),
    calendar: z.enum(["tomorrow-start", "next-week-start", "next-working-day-start"]),
  }),
])

// Emoji is stored as a shortcode (no surrounding colons), matching
// personas/bots/labels — reject colon-wrapped values at the boundary so a
// malformed `:eyes:` can't be persisted.
const statusEmojiSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !value.includes(":"), { message: "Emoji shortcode must not include colons" })
  .nullable()
const statusTextSchema = z.string().max(STATUS_TEXT_MAX_LENGTH).nullable()

export const statusPresetSchema = z
  .object({
    id: z.string().min(1).max(64),
    emoji: statusEmojiSchema,
    text: statusTextSchema,
    defaultDuration: statusDurationSchema.nullable(),
  })
  .refine((p) => isStatusContentful(p), { message: "A status needs an emoji or text" })

export const statusPresetsSchema = z.array(statusPresetSchema).max(MAX_STATUS_PRESETS)

// Upper bound on how far out a status may be set to expire. The server owns the
// persisted active status (it broadcasts to the whole workspace), so it bounds
// the absolute instant a client can send rather than trusting it blindly — the
// duration presets already cap relative durations at a week, but the custom
// date/time path produces an arbitrary instant. A past instant is allowed and
// simply reads as already-cleared (mapRowToUser masks it).
const MAX_STATUS_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000

// Setting an active status: at least one of emoji/text, and an optional
// absolute expiry the client resolves from its chosen duration. Clearing a
// status goes through DELETE, so this path always carries content.
export const setStatusSchema = z
  .object({
    emoji: statusEmojiSchema,
    text: z
      .string()
      .max(STATUS_TEXT_MAX_LENGTH)
      .transform((v) => (v.trim().length === 0 ? null : v.trim()))
      .nullable(),
    expiresAt: z.string().datetime().nullable(),
  })
  .refine((s) => isStatusContentful(s), { message: "A status needs an emoji or text" })
  .refine((s) => !s.expiresAt || new Date(s.expiresAt).getTime() <= Date.now() + MAX_STATUS_EXPIRY_MS, {
    message: "Status expiry is too far in the future",
    path: ["expiresAt"],
  })
