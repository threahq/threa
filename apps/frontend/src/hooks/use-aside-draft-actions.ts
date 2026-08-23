import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"
import type { JSONContent } from "@threa/types"
import type { DraftAttachment } from "@/db"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import type { DraftComposerState } from "./use-draft-composer"

export interface AsideDraftActions {
  /** Persist the draft, then hand its blocks and files to the host composer. */
  send: () => Promise<void>
  /** Discard the draft. */
  remove: () => Promise<void>
  /** True while a send is in flight — both controls are held so one draft is delivered once. */
  busy: boolean
  canSend: boolean
}

export interface AsideDraftHandoff {
  content: JSONContent[]
  attachments: DraftAttachment[]
}

/** How long the source waits for the destination to persist before it keeps its files. */
const DELIVERY_WAIT_MS = 20_000

/**
 * The two things an aside draft can do, kept out of the editor component
 * (INV-15). A send is serialized: the draft is flushed before it leaves, and a
 * second send (or a delete) while one is in flight is refused rather than
 * queueing the same content twice or clearing a draft mid-handoff. The text is
 * copied (the draft survives); the files MOVE — an upload belongs to one
 * message — but only once the destination reports them persisted: if it
 * cannot (or never answers), this draft keeps them and says so. A failed or
 * still-uploading file never travels and is never let go of.
 */
export function useAsideDraftActions(
  composer: DraftComposerState,
  params: {
    onSendToComposer: (handoff: AsideDraftHandoff) => Promise<{ delivered: Promise<boolean> } | null>
    onDone: () => void
  }
): AsideDraftActions {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const { onSendToComposer, onDone } = params
  const uploaded = composer.pendingAttachments.filter((attachment) => attachment.status === "uploaded")
  const canSend = (!isEmptyContent(composer.content) || uploaded.length > 0) && !composer.isUploading

  const send = useCallback(async () => {
    if (inFlight.current) return
    const content = composer.content
    const attachments = composer
      .getPendingAttachmentsSnapshot()
      .filter((attachment) => attachment.status === "uploaded")
      .map(({ id, filename, mimeType, sizeBytes }) => ({ id, filename, mimeType, sizeBytes }))
    if (isEmptyContent(content) && attachments.length === 0) return
    if (composer.isUploading) return
    inFlight.current = true
    setBusy(true)
    try {
      // Persist before handing off: the hand-off copies the text into another
      // composer, so the draft must survive it even if the destination refuses.
      await composer.flushDraft()
      const queued = await onSendToComposer({ content: content.content ?? [], attachments })
      if (!queued) {
        toast.error("Couldn't hand this draft to the composer.")
        return
      }
      onDone()
      if (attachments.length === 0) return
      const delivered = await Promise.race([
        queued.delivered,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DELIVERY_WAIT_MS)),
      ])
      if (delivered) {
        composer.releaseAttachments(attachments.map((attachment) => attachment.id))
      } else {
        toast.error("The composer didn't confirm it has the files; this draft keeps them.")
      }
    } catch {
      // The editor fires send without awaiting it; a rejected flush or
      // hand-off must still reach the user, and the draft stays where it is.
      toast.error("Couldn't hand this draft to the composer.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [composer, onSendToComposer, onDone])

  const remove = useCallback(async () => {
    if (inFlight.current) return
    await composer.clearDraft()
    onDone()
  }, [composer, onDone])

  return { send, remove, busy, canSend }
}
