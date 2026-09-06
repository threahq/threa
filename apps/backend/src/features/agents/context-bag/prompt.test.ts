import { describe, expect, it } from "bun:test"
import { appendBagToSystemPrompt } from "./prompt"
import type { ResolvedBag } from "./resolve"
import { ContextIntents } from "@threahq/types"

function makeBag(overrides: Partial<ResolvedBag> = {}): ResolvedBag {
  return {
    bagId: "sca_1",
    intent: ContextIntents.DISCUSS_THREAD,
    stable: "STABLE REGION",
    delta: "",
    items: [],
    refs: [],
    nextSnapshot: { renderedAt: "2026-04-22T09:00:00Z", items: [], tailMessageId: null },
    ...overrides,
  }
}

describe("appendBagToSystemPrompt", () => {
  const base = { stable: "You are Ariadne.", volatile: "## Current Time\n\n10:00" }

  it("returns the input verbatim when no bag is attached", () => {
    expect(appendBagToSystemPrompt(base, null)).toEqual(base)
  })

  it("appends only the stable region when the delta is empty", () => {
    expect(appendBagToSystemPrompt(base, makeBag({ delta: "" }))).toEqual({
      stable: "You are Ariadne.\n\nSTABLE REGION",
      volatile: "## Current Time\n\n10:00",
    })
  })

  // The bag's two regions straddle the cache boundary: the append-only stable
  // region joins the cached prefix, the per-turn delta stays outside it.
  it("routes the stable region into the cached half and the delta into the volatile half", () => {
    expect(appendBagToSystemPrompt(base, makeBag({ delta: "## Since last turn\n- msg_x edited" }))).toEqual({
      stable: "You are Ariadne.\n\nSTABLE REGION",
      volatile: "## Current Time\n\n10:00\n\n## Since last turn\n- msg_x edited",
    })
  })

  it("ignores an empty base half so an empty persona does not generate stray newlines", () => {
    expect(appendBagToSystemPrompt({ stable: "", volatile: "" }, makeBag({ delta: "DELTA" }))).toEqual({
      stable: "STABLE REGION",
      volatile: "DELTA",
    })
  })

  it("keeps the base prompt when the bag has no content to append", () => {
    expect(appendBagToSystemPrompt(base, makeBag({ stable: "", delta: "" }))).toEqual(base)
  })
})
