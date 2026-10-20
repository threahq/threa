import type { DecisionOutcome, DecisionRequestInput } from "@threahq/remote-session"
import type { PendingQuestion } from "./t3-client"

// The decision API's limits on a card.
const MAX_OPTIONS = 8
const MAX_TITLE_CHARS = 200
const MAX_BODY_CHARS = 8000
const MAX_LABEL_CHARS = 80
const OTHER_OPTION_ID = "other"
const SKIP_OPTION_ID = "skip"

/** What a card's outcome gives T3: an answer, nothing for an optional question, or a blank Other to ask again. */
export type CardAnswer =
  | { kind: "answered"; text: string }
  | { kind: "skipped" }
  | { kind: "blank" }
  | { kind: "unanswered" }

export interface QuestionCard {
  input: Pick<DecisionRequestInput, "title" | "body" | "options" | "allowNote">
  answerFor(outcome: DecisionOutcome): CardAnswer
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * One T3 question as a single-choice card. Each option is a button; "Other" takes the
 * answer from the note unless the question forbids its own answer, and also when it
 * allows several, has no options, or has more than fit, so a listed option past the
 * cap can still be typed. An optional question gets a Skip button when `skippable`.
 */
export function questionCard(question: PendingQuestion, { skippable }: { skippable: boolean }): QuestionCard {
  const skip = skippable && question.required === false
  const other =
    question.allowCustomAnswer !== false ||
    question.multiSelect === true ||
    question.options.length === 0 ||
    question.options.length + (skip ? 1 : 0) > MAX_OPTIONS
  const shown = question.options.slice(0, MAX_OPTIONS - (other ? 1 : 0) - (skip ? 1 : 0))
  const listed = question.options.map((option) =>
    option.description ? `- **${option.label}**: ${option.description}` : `- **${option.label}**`
  )
  const hint = question.multiSelect
    ? "Pick one, or choose Other and list several in the note."
    : other
      ? "For Other, write your answer in the note."
      : undefined
  return {
    input: {
      title: clip(question.header.trim() || "T3 Code has a question", MAX_TITLE_CHARS),
      body: clip([question.question, listed.join("\n"), hint].filter(Boolean).join("\n\n"), MAX_BODY_CHARS),
      options: [
        ...shown.map((option, index) => ({ id: `option_${index}`, label: clip(option.label, MAX_LABEL_CHARS) })),
        ...(other ? [{ id: OTHER_OPTION_ID, label: "Other" }] : []),
        ...(skip ? [{ id: SKIP_OPTION_ID, label: "Skip" }] : []),
      ],
      allowNote: other,
    },
    answerFor: (outcome) => {
      if (outcome.status !== "resolved") return { kind: "unanswered" }
      if (outcome.optionId === SKIP_OPTION_ID) return { kind: "skipped" }
      if (outcome.optionId === OTHER_OPTION_ID) {
        const text = outcome.note?.trim()
        return text ? { kind: "answered", text } : { kind: "blank" }
      }
      const option = shown[Number(outcome.optionId.slice("option_".length))]
      return option ? { kind: "answered", text: option.value ?? option.label } : { kind: "unanswered" }
    },
  }
}
