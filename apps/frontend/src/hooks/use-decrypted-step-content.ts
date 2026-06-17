import { useEffect, useMemo, useSyncExternalStore } from "react"
import { TRACE_SOURCE_TYPES, type AgentSessionStep, type TraceSource, type TraceSourceType } from "@threa/types"
import type { SealedSourceItem } from "@threa/crypto"
import {
  getCachedDecryption,
  requestDecryption,
  subscribeToDecryption,
  type DecryptCacheEntry,
} from "@/lib/crypto/decrypt-cache"
import { resolveDecryptContext } from "@/lib/crypto/decrypt-context"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useStreamFromStore } from "@/stores/stream-store"

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
 *  - `decrypted`  — unlocked, decrypt succeeded; render `content` + `sources`.
 *  - `failed`     — decrypt threw (wrong key, tampered AAD, etc.).
 *
 * A sealed step's citation sources ride INSIDE the ciphertext (E2EE-14), so the
 * decrypted variant carries them — already projected into the same `TraceSource`
 * shape a plaintext step's cleartext `sources` column holds, so the trace
 * dialog's `SourceList` renders both without branching on the producer.
 */
export type DecryptedStepContent =
  | { status: "plaintext"; content: string | undefined }
  | { status: "locked"; content: undefined }
  | { status: "pending"; content: undefined }
  | { status: "decrypted"; content: string; sources: TraceSource[] }
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
  // Session + root-SSK resolution and the "hold until the row hydrates" guard
  // (a doomed thread-id decrypt poisons the cache forever) live in
  // `resolveDecryptContext`, shared with the message and search read paths.
  const stream = useStreamFromStore(streamId)
  const ctx = resolveDecryptContext(workspaceId, streamId, session, stream)
  const opts = ctx.ready ? ctx.opts : null

  const cached = useSyncExternalStore<DecryptCacheEntry | undefined>(
    (listener) => subscribeToDecryption(cacheKey, listener),
    () => getCachedDecryption(cacheKey),
    () => undefined
  )

  // Memoize so the effect deps don't churn on every render — mirrors
  // `useDecryptedMessageContent`'s `readEnvelopePayload` memo, giving `sealed` a
  // stable identity it can enter the dep array with directly.
  const sealed = useMemo(() => readSealedStep(step), [step])
  const needsDecrypt = !!sealed && opts !== null && (cached === undefined || cached.status === "pending")

  useEffect(() => {
    if (!needsDecrypt || !sealed || !opts) return
    void requestDecryption(
      cacheKey,
      { contentMarkdown: "", envelope: sealed.envelope, ciphertext: sealed.ciphertext },
      opts
    )
    // Primitive opts fields, not the per-render object, so a settled decrypt
    // doesn't re-fire on an unrelated stream-row update.
  }, [
    needsDecrypt,
    sealed,
    opts?.privateKey,
    opts?.recipientKeyId,
    opts?.workspaceId,
    opts?.streamId,
    opts?.rootStreamId,
    cacheKey,
  ])

  if (!sealed) return { status: "plaintext", content: step.content }
  // `locked` means the session isn't unlocked. Unlocked-but-not-yet-hydrated
  // falls through to `pending`: the decrypt fires once the row lands and the
  // root is known, never against the bare thread id.
  if (!ctx.ready && ctx.reason === "locked") return { status: "locked", content: undefined }
  if (cached?.status === "decrypted" && cached.content) {
    return {
      status: "decrypted",
      content: cached.content.contentMarkdown,
      sources: toTraceSources(cached.content.sources ?? []),
    }
  }
  if (cached?.status === "failed") return { status: "failed", content: undefined }
  return { status: "pending", content: undefined }
}

/**
 * Project the sealed payload's sources into the renderable `TraceSource` shape.
 * The sealed twin carries no `domain` (it's derivable), so derive it from the
 * url here — same as the reply bubble's source list. An unrecognized `type`
 * falls back to `web`: every sealed source has a url, which is exactly what the
 * web rendering links.
 */
function toTraceSources(sources: SealedSourceItem[]): TraceSource[] {
  return sources.map((s) => {
    const domain = domainOf(s.url)
    return {
      type: isTraceSourceType(s.type) ? s.type : "web",
      title: s.title,
      url: s.url,
      ...(domain ? { domain } : {}),
      ...(s.snippet ? { snippet: s.snippet } : {}),
    }
  })
}

function isTraceSourceType(type: string | undefined): type is TraceSourceType {
  return type !== undefined && (TRACE_SOURCE_TYPES as readonly string[]).includes(type)
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined
  } catch {
    return undefined
  }
}
