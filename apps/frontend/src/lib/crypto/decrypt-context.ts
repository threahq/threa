import type { CachedStream } from "@/db"
import type { E2eSessionState } from "@/stores/e2e-session-store"
import type { DecryptMessageOpts } from "./message-envelope"

/**
 * The session + key + hydration gate every render-time content decrypt shares.
 *
 * Each read surface over an encrypted field (message bodies, trace steps,
 * in-stream search, drafts) must answer the same question before it can decrypt:
 * is the session unlocked, and — for content keyed under a stream's SSK — is the
 * stream row hydrated so the root is known? That logic was copy-pasted across the
 * message, step, and search hooks, including the subtle footgun below. This module
 * owns it once.
 *
 * The footgun: a thread shares its root scratchpad's SSK and carries no wraps of
 * its own, so the key resolves against the root (the wrap AAD is bound to the root
 * id). Until the stream row hydrates the root is unknown, and an absent row is
 * indistinguishable from a top-level stream. Decrypting a thread's content against
 * its own (thread) id finds no wrap, fails, and — because a message/step id is
 * immutable — caches that failure permanently. So a decrypt must hold until the
 * row is present rather than attempt a doomed one.
 */

/** A session that can actually open sealed content: unlocked, with keys in memory. */
export interface UnlockedSession extends E2eSessionState {
  status: "unlocked"
  privateKey: CryptoKey
  keyId: string
}

/** The single predicate for "this session can decrypt" — narrows the key fields non-null. */
export function isSessionUnlocked(session: E2eSessionState): session is UnlockedSession {
  return session.status === "unlocked" && session.privateKey !== null && session.keyId !== null
}

export type DecryptContext =
  | { ready: false; reason: "locked" | "unhydrated" }
  | { ready: true; opts: DecryptMessageOpts }

/**
 * Resolve whether `streamId`'s content can be decrypted right now, and the opts to
 * do it. `streamRow` is the stream the content belongs to (the caller reads it via
 * `useStreamFromStore`); an `undefined` row means the root is not yet known and the
 * caller must hold (see the footgun above) rather than decrypt against the bare id.
 *
 *  - `{ ready: false, reason: "locked" }`     — session not unlocked.
 *  - `{ ready: false, reason: "unhydrated" }` — unlocked, stream row not yet present.
 *  - `{ ready: true, opts }`                  — decrypt with `opts` (root resolved).
 */
export function resolveDecryptContext(
  workspaceId: string,
  streamId: string,
  session: E2eSessionState,
  streamRow: CachedStream | undefined
): DecryptContext {
  if (!isSessionUnlocked(session)) return { ready: false, reason: "locked" }
  if (streamRow === undefined) return { ready: false, reason: "unhydrated" }
  return {
    ready: true,
    opts: {
      privateKey: session.privateKey,
      recipientKeyId: session.keyId,
      workspaceId,
      streamId,
      // A thread resolves its SSK against the root; a top-level stream is its own
      // root, so `undefined` lets `DecryptMessageOpts` default rootStreamId to streamId.
      rootStreamId: streamRow.rootStreamId ?? undefined,
    },
  }
}
