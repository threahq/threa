import { useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { useCreateStream } from "./use-streams"
import { buildDiscussWithAriadneBag, type DiscussTarget } from "@/lib/ariadne/discuss"
import { seedDraftWithContextRef } from "@/lib/context-bag/seed-draft"
import type { DraftContextRef } from "@/lib/context-bag/types"
import { ContextRefKinds } from "@threa/types"

/**
 * The composer sidecar ref that renders the attached chip the moment the user
 * lands on the new scratchpad. Mirrors the wire bag but in the draft's shape.
 * Status is optimistic `"ready"` because the backend precompute handler is
 * warming `context_summaries` in parallel via the `stream:created` outbox event.
 * `originMessageId` carries through so the chip deep-links back to the source.
 */
function buildDraftContextRef(target: DiscussTarget): DraftContextRef {
  const originMessageId = target.sourceMessageId ?? null
  const base = {
    // Whole-thread / whole-conversation context (don't slice). Source message
    // stored as a navigation hint via `originMessageId`.
    fromMessageId: null,
    toMessageId: null,
    originMessageId,
    status: "ready" as const,
    fingerprint: null,
    errorMessage: null,
  }
  if (target.kind === "conversation") {
    return {
      ...base,
      refKind: ContextRefKinds.CONVERSATION,
      streamId: target.rootStreamId,
      conversationId: target.conversationId,
    }
  }
  return { ...base, refKind: ContextRefKinds.THREAD, streamId: target.sourceStreamId, conversationId: null }
}

/**
 * Hook that triggers "Discuss with Ariadne": creates a private scratchpad
 * with the given source stream attached as context, then navigates to it.
 *
 * We deliberately do NOT pass a `displayName` — leaving it null lets the
 * backend `NamingHandler` auto-generate a per-thread title from Ariadne's
 * orientation message (triggered by the `message:created` outbox event for
 * that message). Setting a display name here would suppress naming because
 * `needsAutoNaming` gates on `displayName === null`, and every scratchpad
 * would show up as the same generic label in the sidebar.
 *
 * Surfacing both entry points (context menu + slash command) through one
 * hook keeps cache updates + navigation consistent — the underlying
 * `useCreateStream` mutation already handles optimistic sidebar insertion
 * and sync-engine subscription, so the caller only needs to pass the source
 * stream id.
 */
export function useDiscussWithAriadne(workspaceId: string) {
  const createStream = useCreateStream(workspaceId)
  const navigate = useNavigate()

  return useCallback(
    async (target: DiscussTarget) => {
      let stream
      try {
        stream = await createStream.mutateAsync({
          type: "scratchpad",
          companionMode: "on",
          contextBag: buildDiscussWithAriadneBag(target),
        })
      } catch (err) {
        toast.error("Couldn't start a discussion. Please try again.")
        throw err
      }

      // Seed the new scratchpad's draft with a context-ref sidecar so the
      // composer's `<ContextRefStrip>` renders the attached thread the
      // moment the user lands on the page — atomic with whatever they
      // type next. Status is optimistic `"ready"` because the backend's
      // precompute handler is warming `context_summaries` in parallel
      // via the `stream:created` outbox event.
      //
      // `fromMessageId` carries through to the chip so it can deep-link
      // back to the exact message the discussion was started from.
      //
      // Failure mode: the bag is already persisted server-side at this
      // point (atomic with `createStream`), so a seed failure (e.g. IDB
      // quota / unavailable) is purely cosmetic — the chip will still
      // render on first paint via `useCachedStreamContextBag` once the
      // stream bootstrap loads. Swallow the error rather than surfacing
      // a misleading "couldn't start a discussion" toast for a scratchpad
      // that actually exists in the user's sidebar.
      try {
        await seedDraftWithContextRef({
          workspaceId,
          streamId: stream.id,
          ref: buildDraftContextRef(target),
        })
      } catch (seedErr) {
        console.warn("seedDraftWithContextRef failed; bag is server-side, falling back to bootstrap render", seedErr)
      }

      navigate(`/w/${workspaceId}/s/${stream.id}`)
    },
    [createStream, navigate, workspaceId]
  )
}
