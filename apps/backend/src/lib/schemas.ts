import { z } from "zod"
import {
  STREAM_TYPES,
  VISIBILITY_OPTIONS,
  COMPANION_MODES,
  CONTENT_FORMATS,
  AUTHOR_TYPES,
  NOTIFICATION_LEVELS,
} from "@threa/types"

export const streamTypeSchema = z.enum(STREAM_TYPES)
export const visibilitySchema = z.enum(VISIBILITY_OPTIONS)
export const companionModeSchema = z.enum(COMPANION_MODES)
export const contentFormatSchema = z.enum(CONTENT_FORMATS)
export const authorTypeSchema = z.enum(AUTHOR_TYPES)
export const notificationLevelSchema = z.enum(NOTIFICATION_LEVELS)

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
