import type { DecisionOutcome, DecisionRequestInput } from "@threahq/remote-session"
import type { PendingQuestion } from "./t3-client"

// The decision API's limits on a card.
const MAX_OPTIONS = 8
const MAX_TITLE_CHARS = 200
const MAX_BODY_CHARS = 8000
const MAX_LABEL_CHARS = 80
const OTHER_OPTION_ID = "other"

export interface QuestionCard {
  input: Pick<DecisionRequestInput, "title" | "body" | "options" | "allowNote">
  /** The answer T3 takes for the card's outcome, or undefined when it went unanswered. */
  answerFor(outcome: DecisionOutcome): string | undefined
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * One T3 question as a single-choice card. Each option is a button; "Other" takes the
 * answer from the note when the question allows its own answer or several, has no
 * options, or has more than fit, so a listed option past the cap can still be typed.
 */
export function questionCard(question: PendingQuestion): QuestionCard {
  const other =
    question.allowCustomAnswer === true ||
    question.multiSelect === true ||
    question.options.length === 0 ||
    question.options.length > MAX_OPTIONS
  const shown = question.options.slice(0, other ? MAX_OPTIONS - 1 : MAX_OPTIONS)
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
      ],
      allowNote: other,
    },
    answerFor: (outcome) => {
      if (outcome.status !== "resolved") return undefined
      if (outcome.optionId === OTHER_OPTION_ID) return outcome.note?.trim() || undefined
      const option = shown[Number(outcome.optionId.slice("option_".length))]
      return option ? (option.value ?? option.label) : undefined
    },
  }
}
