import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { JSONContent } from "@threahq/types"
import { audienceQuestionCopy, type AudienceQuestionCopy, type ComposerSendWarning } from "@/lib/reference-audience"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import type { ComposerSubmitOptions } from "./message-composer"

export interface SendAskQuestion {
  tone: ComposerSendWarning["warning"]["tone"]
  copy: AudienceQuestionCopy
  convertibleStreamIds: string[]
}

function askKeyOf(sendWarning: ComposerSendWarning | null): string {
  if (!sendWarning) return ""
  const { warning, targetKey } = sendWarning
  return `${targetKey}|${warning.tone}:${warning.streamIds.join(",")}`
}

function consentKeys(sendWarning: ComposerSendWarning): string[] {
  return sendWarning.warning.streamIds.map((id) => `${sendWarning.targetKey}|${id}`)
}

/** Only an answer about exactly these refs may tell the server the reveal was seen. */
function submitOptionsFor(sendWarning: ComposerSendWarning | null): ComposerSubmitOptions | undefined {
  return sendWarning?.settled && sendWarning.warning.tone === "reveal" ? { confirmedPrivacyWarning: true } : undefined
}

/**
 * Send asks once per exposing source and destination. Consent lasts until the
 * draft empties; an open question lasts until the draft or its warning changes.
 */
export function useSendAsk({
  sendWarning,
  awaitSendWarning,
  content,
}: {
  sendWarning: ComposerSendWarning | null
  awaitSendWarning?: (() => Promise<ComposerSendWarning | null>) | null
  content: JSONContent
}) {
  const copy = useMemo(
    () => (sendWarning ? audienceQuestionCopy(sendWarning.warning, sendWarning.names) : null),
    [sendWarning]
  )
  const askKey = askKeyOf(sendWarning)
  const [asked, setAsked] = useState<{ key: string; content: JSONContent } | null>(null)
  const consented = useRef(new Set<string>())
  const waiting = useRef(false)
  const contentRef = useRef(content)
  contentRef.current = content

  const contentIsEmpty = isEmptyContent(content)
  useEffect(() => {
    if (contentIsEmpty) consented.current = new Set()
  }, [contentIsEmpty])

  const question: SendAskQuestion | null =
    sendWarning && copy && asked?.key === askKey && asked.content === content
      ? { tone: sendWarning.warning.tone, copy, convertibleStreamIds: sendWarning.warning.convertibleStreamIds }
      : null

  const consent = useCallback((answered: ComposerSendWarning | null) => {
    if (answered) consented.current = new Set([...consented.current, ...consentKeys(answered)])
    setAsked(null)
  }, [])

  const decide = useCallback(
    (decided: ComposerSendWarning | null, send: (options?: ComposerSubmitOptions) => void) => {
      if (decided && consentKeys(decided).some((key) => !consented.current.has(key))) {
        setAsked({ key: askKeyOf(decided), content: contentRef.current })
        return
      }
      send(submitOptionsFor(decided))
      consent(decided)
    },
    [consent]
  )

  const submit = useCallback(
    async (send: (options?: ComposerSubmitOptions) => void) => {
      if (waiting.current) return
      if (question) {
        send(submitOptionsFor(sendWarning))
        consent(sendWarning)
        return
      }
      if (!awaitSendWarning) {
        decide(sendWarning, send)
        return
      }
      // A link pasted a moment ago has no answer yet; asking from the old one would skip it.
      const before = contentRef.current
      waiting.current = true
      try {
        const settled = await awaitSendWarning()
        if (contentRef.current !== before) return
        decide(settled, send)
      } finally {
        waiting.current = false
      }
    },
    [question, sendWarning, awaitSendWarning, decide, consent]
  )

  const dismiss = useCallback(() => setAsked(null), [])
  const consentToCurrent = useCallback(() => consent(sendWarning), [consent, sendWarning])

  return { copy, question, submit, dismiss, consent: consentToCurrent }
}
