import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { AgentSessionStep } from "@threa/types"
import {
  getCachedDecryption,
  requestDecryption,
  subscribeToDecryption,
  type DecryptCacheEntry,
} from "@/lib/crypto/decrypt-cache"
import { useE2eSession } from "@/stores/e2e-session-store"

/**
 * Render-time decryption for E2E (enclave) trace steps.
 *
 * The enclave seals each step's content under the stream's SSK; the server only
 * relays ciphertext (INV-E7). This hook is the single read path the trace UI
 * uses to recover the renderable content string — the same string a plaintext
 * step carries in `content`. It mirrors `useDecryptedMessageContent`, reusing
 * the shared decrypt cache (keyed here by `step.id`) and SSK-resolving decrypt
 * pipeline (`tryDecryptMessagePayload` under `requestDecryption`). Like that
 * hook, the viewer's `userId` is passed in (the caller resolves it via
 * `useWorkspaceUserId`) so this stays free of auth-context coupling.
 *
 *  - `plaintext`  — step has no ciphertext; `content` is its plaintext field.
 *  - `locked`     — sealed step but the E2E session isn't unlocked.
 *  - `pending`    — unlocked, decrypt in flight (cache miss on first paint).
 *  - `decrypted`  — unlocked, decrypt succeeded; render `content`.
 *  - `failed`     — decrypt threw (wrong key, tampered AAD, etc.).
 */
export type DecryptedStepContent =
  | { status: "plaintext"; content: string | undefined }
  | { status: "locked"; content: undefined }
  | { status: "pending"; content: undefined }
  | { status: "decrypted"; content: string }
  | { status: "failed"; content: undefined }

function readSealedStep(step: AgentSessionStep): { ciphertext: string; envelope: unknown } | null {
  if (typeof step.contentCiphertext !== "string" || !step.contentEnvelope) return null
  return { ciphertext: step.contentCiphertext, envelope: step.contentEnvelope }
}

export function useDecryptedStepContent(
  step: AgentSessionStep,
  workspaceId: string,
  streamId: string,
  userId: string | null
): DecryptedStepContent {
  const session = useE2eSession(workspaceId, userId ?? "")
  const cacheKey = step.id

  const cached = useSyncExternalStore<DecryptCacheEntry | undefined>(
    (listener) => subscribeToDecryption(cacheKey, listener),
    () => getCachedDecryption(cacheKey),
    () => undefined
  )

  // Memoize so the effect deps don't churn on every render — mirrors
  // `useDecryptedMessageContent`'s `readEnvelopePayload` memo, giving `sealed` a
  // stable identity it can enter the dep array with directly.
  const sealed = useMemo(() => readSealedStep(step), [step])
  const canDecrypt = !!sealed && session.status === "unlocked" && !!session.privateKey && !!session.keyId
  const needsDecrypt = canDecrypt && (cached === undefined || cached.status === "pending")

  useEffect(() => {
    if (!needsDecrypt || !sealed || !session.privateKey || !session.keyId) return
    void requestDecryption(
      cacheKey,
      { contentMarkdown: "", envelope: sealed.envelope, ciphertext: sealed.ciphertext },
      { privateKey: session.privateKey, recipientKeyId: session.keyId, workspaceId, streamId }
    )
  }, [needsDecrypt, sealed, session.privateKey, session.keyId, cacheKey, workspaceId, streamId])

  if (!sealed) return { status: "plaintext", content: step.content }
  if (!canDecrypt) return { status: "locked", content: undefined }
  if (cached?.status === "decrypted" && cached.content) {
    return { status: "decrypted", content: cached.content.contentMarkdown }
  }
  if (cached?.status === "failed") return { status: "failed", content: undefined }
  return { status: "pending", content: undefined }
}
