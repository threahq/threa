import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { JSONContent } from "@threahq/types"
import {
  audienceQuestionCopy,
  type AudienceQuestionCopy,
  type ComposerSendWarning,
  type SendTone,
  type SendVerb,
  type SendWarning,
} from "@/lib/reference-audience"
import { unstampedMarkdown } from "@/lib/display-stamps"
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
      unreachable: convertibleStreamIds,
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
  const [asked, setAsked] = useState<{ key: string; signature: string; send: Send; verb: SendVerb } | null>(null)
  const consented = useRef(new Set<string>())
  const waiting = useRef(false)
  const cancellations = useRef(0)
  const latest = useRef({ content, sendWarning, awaitSendWarning })
  latest.current = { content, sendWarning, awaitSendWarning }

  const contentIsEmpty = isEmptyContent(content)
  useEffect(() => {
    if (contentIsEmpty) consented.current = new Set()
  }, [contentIsEmpty])

  // Markdown, not JSON: an editor round-trip fills in default attrs without the author changing anything.
  const signature = useMemo(() => unstampedMarkdown(content), [content])
  const open = useMemo(
    () => (sendWarning && asked?.key === askKey && asked.signature === signature ? asked : null),
    [sendWarning, asked, askKey, signature]
  )
  const question: SendAskQuestion | null = useMemo(
    () =>
      sendWarning && open
        ? {
            tone: sendWarning.warning.tone,
            copy: audienceQuestionCopy(sendWarning.warning, sendWarning.names, open.verb),
            convertibleStreamIds: sendWarning.warning.convertibleStreamIds,
          }
        : null,
    [sendWarning, open]
  )

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
    (decided: ComposerSendWarning | null, send: Send, verb: SendVerb) => {
      const unanswered =
        decided && consentKeys(decided.targetKey, decided.warning.exposed).some((key) => !consented.current.has(key))
      if (unanswered)
        setAsked({ key: askKeyOf(decided), signature: unstampedMarkdown(latest.current.content), send, verb })
      else sendAndRecord(decided, send)
    },
    [sendAndRecord]
  )

  const settleThenDecide = useCallback(
    async (send: Send, verb: SendVerb): Promise<void> => {
      const { sendWarning: current, awaitSendWarning: awaitSettled } = latest.current
      if (!awaitSettled) {
        decide(current, send, verb)
        return
      }
      // A link pasted a moment ago has no answer yet; asking from the old one would skip it.
      const before = unstampedMarkdown(latest.current.content)
      const cancelledBefore = cancellations.current
      const settled = await awaitSettled()
      // The answer is about the content Send was pressed on; a draft typed into since, or a cancel, waits for the next Send.
      if (unstampedMarkdown(latest.current.content) === before && cancellations.current === cancelledBefore)
        decide(settled, send, verb)
    },
    [decide]
  )

  /** Asking again for the action the open question names answers it; another action takes the question over. */
  const submit = useCallback(
    async (send: Send, verb: SendVerb = "Send") => {
      if (waiting.current) return
      if (open) {
        if (verb === open.verb) sendAndRecord(sendWarning, send)
        else setAsked({ ...open, send, verb })
        return
      }
      waiting.current = true
      try {
        await settleThenDecide(send, verb)
      } finally {
        waiting.current = false
      }
    },
    [open, sendWarning, sendAndRecord, settleThenDecide]
  )

  const answer = useCallback(() => {
    if (open) sendAndRecord(sendWarning, open.send)
  }, [open, sendWarning, sendAndRecord])

  const dismiss = useCallback(() => setAsked(null), [])
  /** Dismiss, and drop a Send still waiting on its answer: the action it was pressed for changed. */
  const cancel = useCallback(() => {
    cancellations.current += 1
    setAsked(null)
  }, [])
  /** The question's alternative converted refs; it answers for what the draft now holds. */
  const recordAlternative = useCallback(() => {
    if (sendWarning) record(sendWarning.targetKey, exposedAfterAlternative(sendWarning.warning))
  }, [record, sendWarning])

  return { copy, question, submit, answer, dismiss, cancel, recordAlternative }
}
