import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import {
  getCachedStreamName,
  getStreamNameCacheVersion,
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
