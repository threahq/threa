import { useEffect, useRef, type RefObject } from "react"
import { toast } from "sonner"
import { parseMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"
import { hasDocContent, type DraftComposerState } from "@/hooks/use-draft-composer"
import type { UseStashComposerResult } from "@/hooks/use-stash-composer"
import {
  acknowledgeShareHandoffBatch,
  claimShareHandoffDrain,
  peekShareHandoffBatch,
  settleShareHandoffBatch,
  subscribeShareHandoff,
  type ShareHandoffBatch,
} from "@/stores/composer-handoff-store"
import type { ComposerControlHandle } from "./message-composer"

interface ComposerHandoffDrainParams {
  workspaceId: string
  /** What this composer's hand-offs are queued under: its stream's id, or its draft scope. */
  target: string
  draftKey: string
  composer: DraftComposerState
  stash: UseStashComposerResult
  controlRef: RefObject<ComposerControlHandle | null>
}

/** Takes the hand-offs queued for `target` into this composer, on mount and as they arrive. */
export function useComposerHandoffDrain({
  workspaceId,
  target,
  draftKey,
  composer,
  stash,
  controlRef,
}: ComposerHandoffDrainParams): void {
  const composerRef = useRef(composer)
  const stashRef = useRef(stash)
  const draftKeyRef = useRef(draftKey)
  composerRef.current = composer
  stashRef.current = stash
  draftKeyRef.current = draftKey

  // A hand-off gets a fresh composer. It stays queued until the destination
  // draft is stashed, then replaces the editor's content, with a typing line after it.
  useEffect(() => {
    let pendingFrame: { id: number; resolve: (active: boolean) => void } | null = null
    let processing = false
    let cancelled = false
    let release: ((passOn?: boolean) => void) | null = null

    const hasPending = () => peekShareHandoffBatch(workspaceId, target) !== null
    const waitForFrame = () =>
      new Promise<boolean>((resolve) => {
        const id = requestAnimationFrame(() => {
          if (pendingFrame?.id === id) pendingFrame = null
          resolve(!cancelled)
        })
        pendingFrame = { id, resolve }
      })
    const nodesForBatch = (batch: ShareHandoffBatch): JSONContent[] =>
      batch.handoffs.flatMap((handoff) => {
        if (handoff.kind === "pointer") {
          return { type: "sharedMessage", attrs: handoff.attrs as unknown as Record<string, unknown> }
        }
        // Already `contentJson` (an aside hand-off) — inserted as-is (INV-58).
        if (handoff.kind === "content") return handoff.content
        const parsed = parseMarkdown(handoff.markdown)
        return {
          type: "blockquote",
          content: parsed.content && parsed.content.length > 0 ? parsed.content : [{ type: "paragraph" }],
        }
      })

    const processPending = async () => {
      if (processing || !hasPending()) return
      const held = claimShareHandoffDrain(workspaceId, target)
      if (!held) return
      release = held
      processing = true
      let failed = false
      const deadline = performance.now() + 5000
      let readyScope: string | null = null
      const retry = async (message: string) => {
        if (cancelled) return false
        if (performance.now() >= deadline) throw new Error(message)
        return waitForFrame()
      }

      try {
        while (!cancelled && hasPending()) {
          const scope = draftKeyRef.current
          const current = composerRef.current
          const editor = controlRef.current?.getEditor?.()
          if (!current.isLoaded || !editor || editor.isDestroyed) {
            readyScope = null
            if (!(await retry("destination composer did not become ready"))) return
            continue
          }
          // Route changes reuse this component; wait for the destination draft's
          // state update instead of reading the previous stream's editor document.
          if (readyScope !== scope) {
            readyScope = scope
            if (!(await retry("destination draft did not hydrate"))) return
            continue
          }

          const attachments = current.getPendingAttachmentsSnapshot()
          if (attachments.some((attachment) => attachment.status === "error")) {
            throw new Error("destination composer has a failed attachment")
          }
          if (attachments.some((attachment) => attachment.id.startsWith("temp_"))) {
            if (!(await retry("destination attachment was not reserved in time"))) return
            continue
          }

          const liveContent = editor.getJSON() as JSONContent
          const hadLivePayload = hasDocContent(liveContent) || attachments.length > 0 || current.contextRefs.length > 0
          const stashed = await stashRef.current.handleStashBeforeReplace(liveContent)
          if (cancelled) return
          if (draftKeyRef.current !== scope) {
            readyScope = null
            continue
          }
          if (hadLivePayload && !stashed) throw new Error("destination draft could not be persisted")

          if (stashed) {
            // A second clear frame lets the pointer-null transition finish before
            // insertion; its late reset would otherwise erase the new share.
            let clearFrames = 0
            while (!cancelled && draftKeyRef.current === scope) {
              const reset = composerRef.current
              const resetEditor = controlRef.current?.getEditor?.()
              const isClear =
                resetEditor &&
                !resetEditor.isDestroyed &&
                !hasDocContent(reset.content) &&
                !hasDocContent(resetEditor.getJSON() as JSONContent) &&
                reset.getPendingAttachmentsSnapshot().length === 0 &&
                reset.contextRefs.length === 0
              clearFrames = isClear ? clearFrames + 1 : 0
              if (clearFrames >= 2) break
              if (!(await retry("destination composer did not clear"))) return
            }
            if (cancelled) return
            if (draftKeyRef.current !== scope) {
              readyScope = null
              continue
            }
          }

          const destinationEditor = controlRef.current?.getEditor?.()
          if (!destinationEditor || destinationEditor.isDestroyed) {
            readyScope = null
            if (!(await retry("destination composer was removed"))) return
            continue
          }
          const batch = peekShareHandoffBatch(workspaceId, target)
          if (!batch) return
          const shareContent: JSONContent = {
            type: "doc",
            content: [...nodesForBatch(batch), { type: "paragraph" }],
          }
          const inserted = destinationEditor.chain().setContent(shareContent).focus("end").run()
          if (!inserted) throw new Error("destination editor rejected the share")
          // An aside draft's files arrive with its blocks and become this
          // draft's own (the source let go of them on delivery).
          composerRef.current.adoptAttachments(
            batch.handoffs.flatMap((handoff) => (handoff.kind === "content" ? handoff.attachments : []))
          )
          acknowledgeShareHandoffBatch(workspaceId, target, batch)
          const persisted = await composerRef.current.flushDraftWithResult({ contentJson: shareContent })
          settleShareHandoffBatch(batch, persisted)
          if (!persisted) toast.error("Couldn't save the shared message as a draft. Keep this composer open.")
        }
      } catch (err) {
        failed = true
        console.error("[composer] failed to prepare share handoff", err)
        toast.error("Couldn't prepare this composer for sharing. Your draft was kept.")
      } finally {
        held()
        processing = false
        if (!cancelled && !failed && hasPending()) void processPending()
      }
    }

    void processPending()
    const unsubscribe = subscribeShareHandoff(workspaceId, target, () => void processPending())
    return () => {
      cancelled = true
      unsubscribe()
      release?.(true)
      const frame = pendingFrame
      if (!frame) return
      cancelAnimationFrame(frame.id)
      pendingFrame = null
      frame.resolve(false)
    }
  }, [workspaceId, target, controlRef])
}
