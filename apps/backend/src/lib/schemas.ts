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
// wrapped to this bot. Validated at the boundary so a malformed key fails
// loudly here rather than as an opaque HPKE-wrap error on the inviting client
// (mirrors the EIK check in enclave-runtimes). Lives here — a zero-feature-dep
// leaf — so the WS `bot:hello` and HTTP presence schemas share one definition
// (INV-31) without importing across the cyclic public-api ↔ bot-runtimes edge.
const E2E_PUBLIC_KEY_BYTES = 32
export const botIdentityKeyFields = {
  publicKey: z
    .base64()
    .refine((v) => Buffer.from(v, "base64").length === E2E_PUBLIC_KEY_BYTES, {
      message: "publicKey must be a 32-byte X25519 key",
    })
    .optional(),
  publicKeyId: z.string().min(1).max(128).optional(),
} as const

// publicKey and publicKeyId are addressing partners — a wrap needs both — so
// reject a half-registered key rather than silently storing an unusable one.
export function bothOrNeitherBotIdentityKey(v: { publicKey?: string; publicKeyId?: string }): boolean {
  return (v.publicKey === undefined) === (v.publicKeyId === undefined)
}
