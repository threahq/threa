import { useCallback, useMemo, type RefObject } from "react"
import type { JSONContent } from "@threahq/types"
import type { RichEditorHandle } from "@/components/editor"
import { convertForAlternative } from "@/components/editor/reference-conversions"
import type { ComposerSendWarning, SendTone } from "@/lib/reference-audience"
import { useSendAsk } from "./use-send-ask"

/** What the primary button shows before anyone asks: the tint, and the reason for its label. */
export interface SendButtonWarning {
  tone: SendTone
  short: string
}

/**
 * `useSendAsk` for a surface that owns a rich editor: answering, dismissing and
 * taking the alternative hand focus back to it, since on desktop the question
 * held focus on a button that unmounts once answered.
 */
export function useEditorSendAsk({
  sendWarning,
  awaitSendWarning,
  content,
  editorRef,
  workspaceId,
  compact,
  sentReferenceKeys,
}: {
  sendWarning: ComposerSendWarning | null
  awaitSendWarning?: (() => Promise<ComposerSendWarning | null>) | null
  content: JSONContent
  editorRef: RefObject<RichEditorHandle | null>
  workspaceId: string | undefined
  /** Touch surfaces leave focus alone: refocusing would raise the keyboard. */
  compact: boolean
  sentReferenceKeys?: ReadonlySet<string>
}) {
  const { copy, question, submit, answer, dismiss, recordAlternative } = useSendAsk({
    sendWarning,
    awaitSendWarning,
    content,
  })

  const refocusEditor = useCallback(() => {
    if (!compact) editorRef.current?.focus()
  }, [compact, editorRef])

  const answerQuestion = useCallback(() => {
    answer()
    refocusEditor()
  }, [answer, refocusEditor])

  const closeQuestion = useCallback(() => {
    dismiss()
    refocusEditor()
  }, [dismiss, refocusEditor])

  /** Escape's first press only takes the question away; true when it did. */
  const escapeQuestion = useCallback(
    (event: { preventDefault(): void }) => {
      if (!question) return false
      event.preventDefault()
      closeQuestion()
      return true
    },
    [question, closeQuestion]
  )

  const takeAlternative = useCallback(() => {
    const editor = editorRef.current?.getEditor()
    if (!editor || !workspaceId || !question) return
    convertForAlternative(editor, workspaceId, question, sentReferenceKeys)
    recordAlternative()
    refocusEditor()
  }, [editorRef, workspaceId, question, sentReferenceKeys, recordAlternative, refocusEditor])

  const labelWithWarning = useCallback((label: string) => (copy ? `${label} — ${copy.short}` : label), [copy])
  const warning = useMemo<SendButtonWarning | null>(
    () => (sendWarning && copy ? { tone: sendWarning.warning.tone, short: copy.short } : null),
    [sendWarning, copy]
  )

  return {
    question,
    submit,
    dismiss,
    answerQuestion,
    closeQuestion,
    escapeQuestion,
    takeAlternative,
    labelWithWarning,
    warning,
  }
}
