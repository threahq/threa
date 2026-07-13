import { describe, expect, test } from "bun:test"
import { PERSONA_ATTACHMENT_BLOCK_MAX_CHARS, PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS } from "../../config"
import {
  planPersonaKnowledge,
  PERSONA_KNOWLEDGE_PROCESSING_NOTE,
  type PersonaKnowledgeLengths,
} from "./persona-knowledge-plan"

function lengths(overrides: Partial<PersonaKnowledgeLengths> = {}): PersonaKnowledgeLengths {
  return { fullTextChars: null, summaryChars: null, ...overrides }
}

describe("planPersonaKnowledge — per-file selection (decision 6)", () => {
  test("full text within the inline cap → mode 'full', render whole", () => {
    const [plan] = planPersonaKnowledge([lengths({ fullTextChars: 500, summaryChars: 40 })])
    expect(plan).toEqual({ mode: "full", truncated: false, source: "fullText", truncateAt: null })
  })

  test("full text over the inline cap falls back to the summary → mode 'summary'", () => {
    const [plan] = planPersonaKnowledge([
      lengths({ fullTextChars: PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS + 1, summaryChars: 120 }),
    ])
    expect(plan).toEqual({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
  })

  test("full text exactly at the inline cap still inlines full", () => {
    const [plan] = planPersonaKnowledge([lengths({ fullTextChars: PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS })])
    expect(plan.mode).toBe("full")
  })

  test("no full text and no summary → mode 'name_only' via the processing note", () => {
    const [plan] = planPersonaKnowledge([lengths()])
    expect(plan).toEqual({ mode: "name_only", truncated: false, source: "processingNote", truncateAt: null })
  })

  test("empty (0-char) columns count as absent, not present", () => {
    const [plan] = planPersonaKnowledge([lengths({ fullTextChars: 0, summaryChars: 0 })])
    expect(plan.mode).toBe("name_only")
    expect(plan.source).toBe("processingNote")
  })
})

describe("planPersonaKnowledge — cumulative block budget walk", () => {
  test("the file that crosses the budget is truncated at the remaining chars", () => {
    // Summaries carry no per-file inline cap, so they can walk the whole block
    // budget: the first summary consumes all but 100 chars, the second overruns.
    const first = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - 100
    const plans = planPersonaKnowledge([lengths({ summaryChars: first }), lengths({ summaryChars: 500 })])
    expect(plans[0]).toEqual({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
    expect(plans[1]).toEqual({ mode: "summary", truncated: true, source: "summary", truncateAt: 100 })
  })

  test("a single file whose body overruns the whole budget is truncated at the full budget", () => {
    const [plan] = planPersonaKnowledge([lengths({ summaryChars: PERSONA_ATTACHMENT_BLOCK_MAX_CHARS + 500 })])
    expect(plan).toEqual({
      mode: "summary",
      truncated: true,
      source: "summary",
      truncateAt: PERSONA_ATTACHMENT_BLOCK_MAX_CHARS,
    })
  })

  test("files after the crossing file degrade to summary-only (full text dropped), untruncated", () => {
    const plans = planPersonaKnowledge([
      lengths({ summaryChars: PERSONA_ATTACHMENT_BLOCK_MAX_CHARS + 100 }),
      lengths({ fullTextChars: 4000, summaryChars: 60 }),
    ])
    expect(plans[0]!.truncated).toBe(true)
    // The later file would have inlined its full text pre-budget, but now shows summary only.
    expect(plans[1]).toEqual({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
  })

  test("a post-budget file with no summary renders the marker (name_only), never dropped", () => {
    const plans = planPersonaKnowledge([
      lengths({ summaryChars: PERSONA_ATTACHMENT_BLOCK_MAX_CHARS + 1 }),
      lengths({ fullTextChars: 3000, summaryChars: null }),
    ])
    expect(plans[1]).toEqual({ mode: "name_only", truncated: false, source: "marker", truncateAt: null })
  })

  test("a post-budget file with an EMPTY-STRING summary gets the marker too, not an empty body", () => {
    // Pre-planner, `summary ?? MARKER` rendered an empty body for a "" summary —
    // indistinguishable from a silent drop (INV-11). Zero chars now means absent
    // in both the prompt and the config-label path; pin it so it can't regress.
    const plans = planPersonaKnowledge([
      lengths({ summaryChars: PERSONA_ATTACHMENT_BLOCK_MAX_CHARS + 1 }),
      lengths({ fullTextChars: 3000, summaryChars: 0 }),
    ])
    expect(plans[1]).toEqual({ mode: "name_only", truncated: false, source: "marker", truncateAt: null })
  })

  test("everything fits under budget → nothing truncated, order preserved", () => {
    const plans = planPersonaKnowledge([
      lengths({ fullTextChars: 100 }),
      lengths({ summaryChars: 50 }),
      lengths({ fullTextChars: 200 }),
    ])
    expect(plans.map((p) => p.mode)).toEqual(["full", "summary", "full"])
    expect(plans.every((p) => !p.truncated)).toBe(true)
  })

  test("a processing note that overruns a nearly-spent budget is itself truncated", () => {
    // Fill the budget to within fewer chars than the processing note, then a
    // content-less file whose note can't fit degrades with a marker.
    const first = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - 5
    const plans = planPersonaKnowledge([lengths({ summaryChars: first }), lengths()])
    expect(PERSONA_KNOWLEDGE_PROCESSING_NOTE.length).toBeGreaterThan(5)
    expect(plans[1]).toEqual({ mode: "name_only", truncated: true, source: "processingNote", truncateAt: 5 })
  })

  test("empty input → empty plan", () => {
    expect(planPersonaKnowledge([])).toEqual([])
  })
})
