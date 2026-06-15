import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession, type E2eSessionStatus } from "@/stores/e2e-session-store"
import {
  getCachedStreamName,
  getStreamNameCacheVersion,
  isStreamNamePending,
  requestStreamName,
  streamNameCacheKey,
  subscribeStreamNameCache,
} from "@/lib/crypto/stream-name-cache"

interface SealedNameStream {
  id: string
  e2eEnabled?: boolean
  sealedNameCiphertext?: string | null
  sealedNameEnvelope?: unknown
  /** The root whose SSK seals this name; a scratchpad is its own root. */
  rootStreamId?: string | null
}

/**
 * The decrypted display name for an E2E stream when the viewer is unlocked, else
 * null. The plaintext `displayName` is server-mutable; the sealed name is
 * AAD-bound to its stream (see `buildNameAad`), so preferring the decrypted copy
 * for an unlocked stream means a malicious server can't silently relabel what the
 * user sees. Returns null for plaintext streams, a locked session, a missing
 * sealed name, or any decrypt failure — callers fall back to the plaintext label
 * (which is also what a locked session shows).
 *
 * Reads the shared `stream-name-cache` (the single decrypt authority), so the
 * open-stream header and the list-surface overlay never drift. Keying the cache
 * on the ciphertext makes the lookup self-guarding: a previous stream's name or
 * a pre-rename name maps to a different key, so it can never flash before the
 * current name's async decrypt resolves.
 */
export function useDecryptedStreamName(
  workspaceId: string,
  stream: SealedNameStream | null | undefined
): string | null {
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const version = useSyncExternalStore(subscribeStreamNameCache, getStreamNameCacheVersion, getStreamNameCacheVersion)

  const streamId = stream?.id
  const e2eEnabled = stream?.e2eEnabled ?? false
  const ciphertext = stream?.sealedNameCiphertext ?? null
  const envelope = stream?.sealedNameEnvelope ?? null
  const rootStreamId = stream?.rootStreamId ?? undefined
  const unlocked = session.status === "unlocked"
  const keyId = session.keyId
  const privateKey = session.privateKey

  const key = e2eEnabled && streamId && ciphertext ? streamNameCacheKey(workspaceId, streamId, ciphertext) : null

  useEffect(() => {
    if (!key || !streamId || !ciphertext || !envelope || !unlocked || !keyId || !privateKey) return
    requestStreamName(
      key,
      { ciphertext, envelope },
      { workspaceId, streamId, rootStreamId: rootStreamId ?? streamId, recipientKeyId: keyId, privateKey }
    )
  }, [key, streamId, ciphertext, envelope, rootStreamId, unlocked, keyId, privateKey, workspaceId])

  return useMemo(
    () => (key && unlocked ? getCachedStreamName(key) : null),
    // `version` re-reads the cache when a decrypt lands; the rest key the lookup.
    [key, unlocked, version]
  )
}

/**
 * Whether a sealed E2E stream's name is still resolving, given the session status:
 * the session is settling (`unknown`/`unlocking`) or it's unlocked and the decrypt
 * hasn't landed yet — so a surface can show a loader instead of flashing the
 * placeholder during the cold-load decrypt window. False for plaintext streams, a
 * locked/no-key session (the placeholder is then the settled answer), and once the
 * name has decrypted (or definitively failed).
 *
 * Pure so the single decision can be computed at the read boundary that already
 * resolves the name — the open-stream header (via `useStreamNameDecrypting`) and
 * the sidebar's stream-list builder — rather than each leaf row re-wiring the
 * session. Reads the same cache as the name overlay, so loader and label agree.
 */
export function resolveSealedNamePending(
  workspaceId: string,
  stream: SealedNameStream | null | undefined,
  sessionStatus: E2eSessionStatus
): boolean {
  const e2eEnabled = stream?.e2eEnabled ?? false
  const streamId = stream?.id
  const ciphertext = stream?.sealedNameCiphertext ?? null
  if (!e2eEnabled || !streamId || !ciphertext) return false
  if (sessionStatus === "unknown" || sessionStatus === "unlocking") return true
  if (sessionStatus === "unlocked") return isStreamNamePending(streamNameCacheKey(workspaceId, streamId, ciphertext))
  return false
}

/**
 * Hook form of {@link resolveSealedNamePending} for a single open stream (the
 * header), which already has session context. List surfaces resolve this through
 * their stream-list builder instead, off the same shared cache.
 */
export function useStreamNameDecrypting(workspaceId: string, stream: SealedNameStream | null | undefined): boolean {
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  // `version` re-evaluates pending when a decrypt settles (including a failure,
  // which doesn't change the overlaid row).
  const version = useSyncExternalStore(subscribeStreamNameCache, getStreamNameCacheVersion, getStreamNameCacheVersion)

  return useMemo(
    () => resolveSealedNamePending(workspaceId, stream, session.status),
    [workspaceId, stream, session.status, version]
  )
}
