import { describe, expect, test } from "bun:test"
import { PERSONA_ATTACHMENT_BLOCK_MAX_CHARS, PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS } from "../../config"
import {
  planPersonaKnowledge,
  PERSONA_KNOWLEDGE_FAILURE_NOTE,
  PERSONA_KNOWLEDGE_PROCESSING_NOTE,
  type PersonaKnowledgeLengths,
  type PersonaKnowledgePlan,
} from "./persona-knowledge-plan"

function lengths(overrides: Partial<PersonaKnowledgeLengths> = {}): PersonaKnowledgeLengths {
  return { fullTextChars: null, summaryChars: null, ...overrides }
}

/** The whole-body length one plan's source renders (0 for a marker-only row). */
function wholeBodyLen(item: PersonaKnowledgeLengths, plan: PersonaKnowledgePlan): number {
  switch (plan.source) {
    case "fullText":
      return item.fullTextChars ?? 0
    case "summary":
      return item.summaryChars ?? 0
    case "processingNote":
      return PERSONA_KNOWLEDGE_PROCESSING_NOTE.length
    case "failureNote":
      return PERSONA_KNOWLEDGE_FAILURE_NOTE.length
    case "marker":
      return 0
  }
}

/**
 * The content chars the plans spend against the block budget: a whole body's
 * length, a truncated body's slice (`truncateAt`), and 0 for marker-only rows.
 * Excludes the `…[truncated]` suffix and the marker sentinel — those are fixed
 * structural chrome, like the `### filename` headings, not budgeted content.
 */
function spentChars(plans: PersonaKnowledgePlan[], items: PersonaKnowledgeLengths[]): number {
  return plans.reduce((total, plan, index) => {
    if (plan.source === "marker") return total
    if (plan.truncated) return total + (plan.truncateAt ?? 0)
    return total + wholeBodyLen(items[index]!, plan)
  }, 0)
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

  test("budget-aware degradation: a full text that won't fit the remaining budget degrades to a WHOLE summary", () => {
    // The first file's whole summary fits and leaves only 100 chars. The second
    // file's full text (4000) overruns that remainder, but its summary (60) fits —
    // a complete summary beats a truncated full text, so it degrades, untruncated.
    const first = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - 100
    const plans = planPersonaKnowledge([
      lengths({ summaryChars: first }),
      lengths({ fullTextChars: 4000, summaryChars: 60 }),
    ])
    expect(plans[0]).toEqual({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
    expect(plans[1]).toEqual({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
  })

  test("continuous walk: a summary tail renders only while budget remains, then markers — total within cap", () => {
    // A near-limit first file leaves ~200 chars; the next 300-char summary can't
    // fit whole, so it is the sole truncation and the remaining tail is markers.
    const near = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - 200
    const items = [
      lengths({ summaryChars: near }),
      lengths({ summaryChars: 300 }),
      lengths({ summaryChars: 300 }),
      lengths({ summaryChars: 300 }),
    ]
    const plans = planPersonaKnowledge(items)
    expect(plans[0]).toEqual({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
    expect(plans[1]).toEqual({ mode: "summary", truncated: true, source: "summary", truncateAt: 200 })
    expect(plans[2]).toEqual({ mode: "name_only", truncated: false, source: "marker", truncateAt: null })
    expect(plans[3]).toEqual({ mode: "name_only", truncated: false, source: "marker", truncateAt: null })
    expect(spentChars(plans, items)).toBeLessThanOrEqual(PERSONA_ATTACHMENT_BLOCK_MAX_CHARS)
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

describe("planPersonaKnowledge — failure note (T3)", () => {
  test("content-less file with extractionFailed → the failure note (name_only), budget-accounted", () => {
    const [plan] = planPersonaKnowledge([lengths({ extractionFailed: true })])
    expect(plan).toEqual({ mode: "name_only", truncated: false, source: "failureNote", truncateAt: null })
  })

  test("content-less file still processing (no failure flag) → the processing note", () => {
    const [plan] = planPersonaKnowledge([lengths({ extractionFailed: false })])
    expect(plan).toEqual({ mode: "name_only", truncated: false, source: "processingNote", truncateAt: null })
  })

  test("extractionFailed is ignored once real content exists → the content wins", () => {
    const [plan] = planPersonaKnowledge([lengths({ summaryChars: 40, extractionFailed: true })])
    expect(plan).toEqual({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
  })

  test("a failure note that can't fit the remaining budget is itself truncated like the processing note", () => {
    const first = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - 4
    const plans = planPersonaKnowledge([lengths({ summaryChars: first }), lengths({ extractionFailed: true })])
    expect(PERSONA_KNOWLEDGE_FAILURE_NOTE.length).toBeGreaterThan(4)
    expect(plans[1]).toEqual({ mode: "name_only", truncated: true, source: "failureNote", truncateAt: 4 })
  })
})

describe("planPersonaKnowledge — budget invariant (T1)", () => {
  test("for ANY input the spent content never exceeds the block budget and at most one file is truncated", () => {
    const rng = mulberry32(0x5eed)
    for (let iteration = 0; iteration < 500; iteration++) {
      const count = Math.floor(rng() * 6) // 0..5, the real cap
      const items: PersonaKnowledgeLengths[] = Array.from({ length: count }, () => ({
        // Draw across the whole range: absent, tiny, near-cap, and over-cap bodies.
        fullTextChars: rng() < 0.35 ? null : Math.floor(rng() * (PERSONA_ATTACHMENT_BLOCK_MAX_CHARS * 1.5)),
        summaryChars: rng() < 0.35 ? null : Math.floor(rng() * (PERSONA_ATTACHMENT_BLOCK_MAX_CHARS * 1.5)),
        extractionFailed: rng() < 0.5,
      }))
      const plans = planPersonaKnowledge(items)
      expect(plans).toHaveLength(count)
      expect(spentChars(plans, items)).toBeLessThanOrEqual(PERSONA_ATTACHMENT_BLOCK_MAX_CHARS)
      expect(plans.filter((p) => p.truncated).length).toBeLessThanOrEqual(1)
    }
  })
})

/** Tiny deterministic PRNG so the property sweep is reproducible (no test flake). */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
