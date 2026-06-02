import { z } from "zod"
import {
  STREAM_TYPES,
  VISIBILITY_OPTIONS,
  COMPANION_MODES,
  CONTENT_FORMATS,
  AUTHOR_TYPES,
  NOTIFICATION_LEVELS,
  parseHHMM,
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
