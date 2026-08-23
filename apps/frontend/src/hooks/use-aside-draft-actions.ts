import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"
import type { JSONContent } from "@threa/types"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import type { DraftComposerState } from "./use-draft-composer"

export interface AsideDraftActions {
  /** Persist the draft, then hand its blocks to the host composer. */
  send: () => Promise<void>
  /** Discard the draft. */
  remove: () => Promise<void>
  /** True while a send is in flight — both controls are held so one draft is delivered once. */
  busy: boolean
  canSend: boolean
}

/**
 * The two things an aside draft can do, kept out of the editor component
 * (INV-15). A send is serialized: the draft is flushed before it leaves, and a
 * second send (or a delete) while one is in flight is refused rather than
 * queueing the same content twice or clearing a draft mid-handoff.
 */
export function useAsideDraftActions(
  composer: DraftComposerState,
  params: { onSendToComposer: (content: JSONContent[]) => Promise<boolean>; onDone: () => void }
): AsideDraftActions {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const { onSendToComposer, onDone } = params

  const send = useCallback(async () => {
    if (inFlight.current) return
    const content = composer.content
    if (isEmptyContent(content)) return
    inFlight.current = true
    setBusy(true)
    try {
      // Persist before handing off: the hand-off is a copy into another
      // composer, so the draft must survive it even if the destination refuses.
      await composer.flushDraft()
      if (!(await onSendToComposer(content.content ?? []))) {
        toast.error("Couldn't hand this draft to the composer.")
        return
      }
      onDone()
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

  return { send, remove, busy, canSend: !isEmptyContent(composer.content) }
}
