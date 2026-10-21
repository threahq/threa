import { describe, expect, test } from "bun:test"

import { questionCard } from "./question-card"
import type { PendingQuestion } from "./t3-client"
import { DECISION, picked } from "./t3.test-support"

function question(fields: Partial<PendingQuestion> = {}): PendingQuestion {
  return { id: "q", header: "Deploy", question: "Where to?", options: [], ...fields }
}

const options = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ label: `Region ${index}`, description: "" }))

describe("questionCard", () => {
  test("a multi-select question adds Other, answered from the note", () => {
    const card = questionCard(question({ options: options(2), multiSelect: true }), { skippable: true })

    expect({
      options: card.input.options.map((option) => option.id),
      allowNote: card.input.allowNote,
      body: card.input.body,
      other: card.answerFor(picked("other", "Region 0, Region 1")),
      blankNote: card.answerFor(picked("other", "  ")),
      listed: card.answerFor(picked("option_1")),
    }).toEqual({
      options: ["option_0", "option_1", "other"],
      allowNote: true,
      body: "Where to?\n\n- **Region 0**\n- **Region 1**\n\nPick one, or choose Other and list several in the note.",
      other: { kind: "answered", text: "Region 0, Region 1" },
      blankNote: { kind: "blank" },
      listed: { kind: "answered", text: "Region 1" },
    })
  })

  test("more options than a card holds keep seven buttons and list the rest for the note", () => {
    const card = questionCard(question({ options: options(10) }), { skippable: true })

    expect({
      options: card.input.options.map((option) => option.id),
      lastListed: card.input.body?.includes("- **Region 9**"),
    }).toEqual({
      options: ["option_0", "option_1", "option_2", "option_3", "option_4", "option_5", "option_6", "other"],
      lastListed: true,
    })
  })

  test("fits the card's limits and has no answer when the card closes unanswered", () => {
    const card = questionCard(
      question({ header: "  ", question: "x".repeat(9000), options: [{ label: "y".repeat(100), description: "" }] }),
      { skippable: true }
    )

    expect({
      title: card.input.title,
      bodyLength: card.input.body?.length,
      bodyEnd: card.input.body?.endsWith("**\n\nFor Other, write your answer in the note."),
      labelLength: card.input.options[0]!.label?.length,
      cancelled: card.answerFor({ status: "cancelled", decision: DECISION }),
    }).toEqual({
      title: "T3 Code has a question",
      bodyLength: 8000,
      bodyEnd: true,
      labelLength: 80,
      cancelled: { kind: "unanswered" },
    })
  })

  test("options too long for the card give way before the question and its hint", () => {
    const card = questionCard(question({ options: [{ label: "Region", description: "z".repeat(9000) }] }), {
      skippable: true,
    })

    expect({
      start: card.input.body?.startsWith("Where to?\n\n- **Region**"),
      end: card.input.body?.endsWith("…\n\nFor Other, write your answer in the note."),
      withinLimit: card.input.body!.length <= 8000,
    }).toEqual({ start: true, end: true, withinLimit: true })
  })

  test("a question that forbids its own answer has no Other, and an optional one can be skipped", async () => {
    const optional = question({ options: options(2), allowCustomAnswer: false, required: false })
    const card = questionCard(optional, { skippable: true })

    expect({
      options: card.input.options.map((option) => option.id),
      allowNote: card.input.allowNote,
      skipped: card.answerFor(picked("skip")),
      unskippable: questionCard(optional, { skippable: false }).input.options.map((option) => option.id),
    }).toEqual({
      options: ["option_0", "option_1", "skip"],
      allowNote: false,
      skipped: { kind: "skipped" },
      unskippable: ["option_0", "option_1"],
    })
  })
})
