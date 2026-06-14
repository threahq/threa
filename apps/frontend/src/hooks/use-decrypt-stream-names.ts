import { useEffect, useMemo } from "react"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { requestStreamName, streamNameCacheKey } from "@/lib/crypto/stream-name-cache"

/**
 * Background decryptor for E2E stream names. Mounted once per workspace, it walks
 * the cached streams and — once the session is unlocked — kicks off a decrypt for
 * every sealed name into the memory-only `stream-name-cache`. The store-read
 * overlay (`useWorkspaceStreams`) then reflects the decrypted name everywhere a
 * label is resolved, with the plaintext held only in memory.
 *
 * The trigger is separate from the read so decrypts fire from one place (here +
 * the open-stream header) rather than from each render of each list row.
 * `requestStreamName` is idempotent per `(stream, ciphertext)`, so the effect
 * re-running as names land is cheap (a `Map.has` per stream).
 */
export function useDecryptStreamNames(workspaceId: string): void {
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const streams = useWorkspaceStreams(workspaceId)

  const unlocked = session.status === "unlocked"
  const keyId = session.keyId
  const privateKey = session.privateKey

  // Only sealed E2E streams matter; deriving the targets keeps the decrypt loop
  // off non-E2E streams and the churny sidebar-preview fields.
  const targets = useMemo(
    () =>
      streams
        .filter((stream) => stream.e2eEnabled && stream.sealedNameCiphertext && stream.sealedNameEnvelope)
        .map((stream) => ({
          id: stream.id,
          rootStreamId: stream.rootStreamId ?? stream.id,
          ciphertext: stream.sealedNameCiphertext as string,
          envelope: stream.sealedNameEnvelope,
        })),
    [streams]
  )

  useEffect(() => {
    if (!unlocked || !keyId || !privateKey) return
    for (const target of targets) {
      requestStreamName(
        streamNameCacheKey(workspaceId, target.id, target.ciphertext),
        { ciphertext: target.ciphertext, envelope: target.envelope },
        {
          workspaceId,
          streamId: target.id,
          rootStreamId: target.rootStreamId,
          recipientKeyId: keyId,
          privateKey,
        }
      )
    }
  }, [targets, unlocked, keyId, privateKey, workspaceId])
}
