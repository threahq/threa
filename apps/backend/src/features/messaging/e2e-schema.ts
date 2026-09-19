import { z } from "zod"

/**
 * The wire shape of a sealed message body, shared by the first-party create
 * handler and the public API's sealed send. One definition because the caps
 * and the envelope framing are the same contract on both doors (INV-33) — a
 * client that can seal for one can seal for the other.
 *
 * Size caps bound the per-message storage footprint — without them a
 * workspace member could post multi-MB envelopes that never decrypt for
 * anyone but bloat `messages.envelope` (JSONB) and `messages.ciphertext`
 * (BYTEA). 1 MB of base64 ciphertext leaves ~750 KB of plaintext, plenty
 * for messages; the 100-recipient cap covers Phase 4 per-device wraps.
 */
export const MAX_E2E_CIPHERTEXT_BASE64_BYTES = 1_000_000
export const MAX_E2E_RECIPIENTS = 100
export const MAX_E2E_RECIPIENT_FIELD_BYTES = 4096

const e2eRecipientSchema = z.object({
  recipientKeyId: z.string().min(1).max(256),
  enc: z.string().min(1).max(MAX_E2E_RECIPIENT_FIELD_BYTES),
  ct: z.string().min(1).max(MAX_E2E_RECIPIENT_FIELD_BYTES),
})

/**
 * v1 — per-message recipient fan-out (@threahq/crypto `Envelope`). The message
 * key is wrapped to each recipient inline. Kept for read-compat; the SSK path
 * (v2) is the direction for new messages.
 */
export const e2eEnvelopeV1Schema = z.object({
  v: z.number().int().positive(),
  ciphertext: z.string().min(1).max(MAX_E2E_CIPHERTEXT_BASE64_BYTES),
  iv: z.string().min(1).max(64),
  aad: z.string().max(4096),
  recipients: z.array(e2eRecipientSchema).min(1).max(MAX_E2E_RECIPIENTS),
})

/**
 * v2 — per-stream symmetric key (@threahq/crypto `StreamEnvelope`). No inline
 * recipients: the SSK is wrapped out of band in `stream_e2e_key_wraps`. The
 * envelope carries only the framing; the AES-GCM ciphertext rides the
 * top-level `ciphertext` field. `keyGeneration` selects which SSK generation
 * (and therefore which wrap) opens it.
 */
export const e2eEnvelopeV2Schema = z.object({
  v: z.number().int().positive(),
  keyGeneration: z.number().int().nonnegative(),
  iv: z.string().min(1).max(64),
  aad: z.string().min(1).max(4096),
})

/**
 * The two envelope shapes are structurally disjoint (v2 has `keyGeneration`
 * and no `recipients`; v1 has `recipients` and an inline `ciphertext`), so the
 * union discriminates without a version literal. v2 is tried first since it is
 * the path new messages take.
 */
export const e2eEnvelopeSchema = z.union([e2eEnvelopeV2Schema, e2eEnvelopeV1Schema])

/**
 * A body sealed client-side under the stream's symmetric key: the bytes plus
 * their framing, both stored verbatim. One definition for every sealed slot a
 * client writes (message, decision card, decision note) so a client that can
 * seal for one door can seal for the next (INV-33). Only the current envelope
 * shape is accepted: the legacy fan-out shape is read-compat, never something
 * a new client should mint.
 */
export const sealedBodySchema = z.object({
  ciphertext: z.string().min(1, "ciphertext is required").max(MAX_E2E_CIPHERTEXT_BASE64_BYTES),
  envelope: e2eEnvelopeV2Schema,
})
