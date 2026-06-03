import { useEffect, useState } from "react"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { tryOpenStreamName } from "@/lib/crypto/message-envelope"

interface SealedNameStream {
  id: string
  e2eEnabled?: boolean
  sealedNameCiphertext?: string | null
  sealedNameEnvelope?: unknown
}

/**
 * The decrypted display name for an E2E stream when the viewer is unlocked, else
 * null. The plaintext `displayName` is server-mutable; the sealed name is
 * AAD-bound to its stream (see `buildNameAad`), so preferring the decrypted copy
 * for an unlocked stream means a malicious server can't silently relabel what the
 * user sees. Returns null for plaintext streams, a locked session, a missing
 * sealed name, or any decrypt failure — callers fall back to the plaintext label
 * (which is also what a locked session shows).
 */
export function useDecryptedStreamName(
  workspaceId: string,
  stream: SealedNameStream | null | undefined
): string | null {
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const [name, setName] = useState<string | null>(null)

  const streamId = stream?.id
  const e2eEnabled = stream?.e2eEnabled ?? false
  const ciphertext = stream?.sealedNameCiphertext ?? null
  const sealedEnvelope = stream?.sealedNameEnvelope ?? null
  const unlocked = session.status === "unlocked"
  const keyId = session.keyId
  const privateKey = session.privateKey

  useEffect(() => {
    if (!e2eEnabled || !streamId || !ciphertext || !sealedEnvelope || !unlocked || !keyId || !privateKey) {
      setName(null)
      return
    }
    let cancelled = false
    void tryOpenStreamName(
      { ciphertext, envelope: sealedEnvelope },
      { workspaceId, streamId, recipientKeyId: keyId, privateKey }
    ).then((decrypted) => {
      if (!cancelled) setName(decrypted)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId, streamId, e2eEnabled, ciphertext, sealedEnvelope, unlocked, keyId, privateKey])

  return name
}
