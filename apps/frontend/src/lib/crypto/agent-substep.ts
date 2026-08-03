import { db } from "@/db"
import { tryDecryptMessagePayload } from "@/lib/crypto/message-envelope"
import { getE2eSessionState } from "@/stores/e2e-session-store"

/**
 * Decrypt an agent substep's sealed phase text. Both live substep consumers (the
 * per-message trace hook and the workspace sync store path) share this resolve +
 * decrypt sequence (INV-35). Returns null when the session is locked, the stream
 * row isn't known, or the open fails — the substep is ephemeral, so a miss is
 * skipped silently.
 */
export async function decryptAgentSubstepText(
  payload: { streamId: string; ciphertext: string; envelope: unknown },
  context: { workspaceId: string; userId: string }
): Promise<string | null> {
  const session = getE2eSessionState(context.workspaceId, context.userId)
  if (session.status !== "unlocked" || !session.privateKey || !session.keyId) return null
  // The substep's stream may be a thread, which shares its root's SSK —
  // resolve the key against the root.
  const rootStreamId = (await db.streams.get(payload.streamId))?.rootStreamId ?? undefined
  const decrypted = await tryDecryptMessagePayload(
    { contentMarkdown: "", ciphertext: payload.ciphertext, envelope: payload.envelope },
    {
      privateKey: session.privateKey,
      recipientKeyId: session.keyId,
      workspaceId: context.workspaceId,
      streamId: payload.streamId,
      rootStreamId,
    }
  ).catch(() => null)
  return decrypted?.contentMarkdown || null
}
