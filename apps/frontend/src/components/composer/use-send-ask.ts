import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { JSONContent } from "@threahq/types"
import {
  audienceQuestionCopy,
  type AudienceQuestionCopy,
  type ComposerSendWarning,
  type SendTone,
  type SendWarning,
} from "@/lib/reference-audience"
import { contentSignature } from "@/lib/display-stamps"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import type { ComposerSubmitOptions } from "./message-composer"

type Send = (options?: ComposerSubmitOptions) => void

export interface SendAskQuestion {
  tone: SendTone
  copy: AudienceQuestionCopy
  convertibleStreamIds: string[]
}

function askKeyOf(sendWarning: ComposerSendWarning | null): string {
  if (!sendWarning) return ""
  const { warning, targetKey } = sendWarning
  return `${targetKey}|${warning.tone}:${warning.exposed.reveal.join(",")}:${warning.exposed.unreachable.join(",")}`
}

/** A reveal and an unreachable link are separate consents: seeing one never answers the other. */
function consentKeys(targetKey: string, exposed: SendWarning["exposed"]): string[] {
  return (["reveal", "unreachable"] as const).flatMap((tone) =>
    exposed[tone].map((streamId) => `${targetKey}|${tone}|${streamId}`)
  )
}

/**
 * What the draft exposes once the alternative converted its refs: shares
 * turned into links stop revealing (the author declined that), message links
 * turned into shares now reveal.
 */
function exposedAfterAlternative({ tone, exposed, convertibleStreamIds }: SendWarning): SendWarning["exposed"] {
  const converted = new Set(convertibleStreamIds)
  if (tone === "reveal") {
    return {
      reveal: exposed.reveal.filter((id) => !converted.has(id)),
      unreachable: [...new Set([...exposed.unreachable, ...convertibleStreamIds])],
    }
  }
  return { reveal: convertibleStreamIds, unreachable: exposed.unreachable }
}

/** Only an answer about exactly these refs may tell the server the reveal was seen. */
function submitOptionsFor(sendWarning: ComposerSendWarning | null): ComposerSubmitOptions | undefined {
  return sendWarning?.settled && sendWarning.warning.tone === "reveal" ? { confirmedPrivacyWarning: true } : undefined
}

/**
 * Send asks once per exposing source, tone and destination. Consent lasts until
 * the draft empties; an open question lasts until the draft's content (not its
 * display stamps) or its warning changes.
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
  const [asked, setAsked] = useState<{ key: string; signature: string } | null>(null)
  const consented = useRef(new Set<string>())
  const waiting = useRef(false)
  const contentRef = useRef(content)
  contentRef.current = content

  const contentIsEmpty = isEmptyContent(content)
  useEffect(() => {
    if (contentIsEmpty) consented.current = new Set()
  }, [contentIsEmpty])

  const askedStillHolds = useMemo(
    () => asked !== null && asked.key === askKey && asked.signature === contentSignature(content),
    [asked, askKey, content]
  )
  const question: SendAskQuestion | null =
    sendWarning && copy && askedStillHolds
      ? { tone: sendWarning.warning.tone, copy, convertibleStreamIds: sendWarning.warning.convertibleStreamIds }
      : null

  const record = useCallback((targetKey: string, exposed: SendWarning["exposed"]) => {
    consented.current = new Set([...consented.current, ...consentKeys(targetKey, exposed)])
    setAsked(null)
  }, [])

  const sendAndRecord = useCallback(
    (answered: ComposerSendWarning | null, send: Send) => {
      send(submitOptionsFor(answered))
      if (answered) record(answered.targetKey, answered.warning.exposed)
      else setAsked(null)
    },
    [record]
  )

  const decide = useCallback(
    (decided: ComposerSendWarning | null, send: Send) => {
      const unanswered =
        decided && consentKeys(decided.targetKey, decided.warning.exposed).some((key) => !consented.current.has(key))
      if (unanswered) setAsked({ key: askKeyOf(decided), signature: contentSignature(contentRef.current) })
      else sendAndRecord(decided, send)
    },
    [sendAndRecord]
  )

  const latest = useRef({ sendWarning, awaitSendWarning })
  latest.current = { sendWarning, awaitSendWarning }

  const settleThenDecide = useCallback(
    async (send: Send): Promise<void> => {
      const { sendWarning: current, awaitSendWarning: awaitSettled } = latest.current
      if (!awaitSettled) {
        decide(current, send)
        return
      }
      // A link pasted a moment ago has no answer yet; asking from the old one would skip it.
      const before = contentSignature(contentRef.current)
      const settled = await awaitSettled()
      // The answer is about the content Send was pressed on; anything typed since is decided afresh.
      if (contentSignature(contentRef.current) === before) decide(settled, send)
      else await settleThenDecide(send)
    },
    [decide]
  )

  const submit = useCallback(
    async (send: Send) => {
      if (waiting.current) return
      if (question) {
        sendAndRecord(sendWarning, send)
        return
      }
      waiting.current = true
      try {
        await settleThenDecide(send)
      } finally {
        waiting.current = false
      }
    },
    [question, sendWarning, sendAndRecord, settleThenDecide]
  )

  const dismiss = useCallback(() => setAsked(null), [])
  /** The question's alternative converted refs; it answers for what the draft now holds. */
  const recordAlternative = useCallback(() => {
    if (sendWarning) record(sendWarning.targetKey, exposedAfterAlternative(sendWarning.warning))
  }, [record, sendWarning])

  return { copy, question, submit, dismiss, recordAlternative }
}
