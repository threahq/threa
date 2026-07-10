import { describe, expect, it } from "vitest"
import type { DelegationSummary } from "@threa/types"
import { delegationContextItems, withDelegations } from "./delegations"
import type { DerivedStreamContext, LinkContextItem } from "./types"
import { CONTEXT_CATEGORIES, type ContextCategory } from "./types"

function summary(overrides: Partial<DelegationSummary> = {}): DelegationSummary {
  return {
    id: "dlg_1",
    streamId: "stream_1",
    title: "Add rate limiting",
    status: "running",
    claimedByLabel: "Kris's MacBook",
    resultMessageId: null,
    statusNote: null,
    createdEventId: "event_1",
    createdAt: "2026-07-09T10:00:00.000Z",
    statusChangedAt: "2026-07-09T10:05:00.000Z",
    ...overrides,
  }
}

function emptyDerived(): DerivedStreamContext {
  return {
    items: [],
    counts: Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as Record<ContextCategory, number>,
    total: 0,
  }
}

describe("delegationContextItems", () => {
  it("maps the summary onto a panel item whose jump target is the created event", () => {
    const [item] = delegationContextItems([summary()])
    expect(item).toMatchObject({
      key: "delegation:dlg_1",
      category: "delegation",
      sourceMessageId: "event_1",
      title: "Add rate limiting",
      status: "running",
      claimedByLabel: "Kris's MacBook",
    })
  })
})

describe("withDelegations", () => {
  it("interleaves by recency and counts the new category", () => {
    const link: LinkContextItem = {
      key: "link:https://example.com",
      category: "link",
      createdAt: "2026-07-09T09:00:00.000Z",
      sourceMessageId: "msg_1",
      snippet: "",
      url: "https://example.com",
      title: null,
      siteName: null,
      faviconUrl: null,
      imageUrl: null,
      previewKind: "generic",
      badge: null,
      refCount: 1,
    }
    const derived: DerivedStreamContext = {
      ...emptyDerived(),
      items: [link],
      counts: { ...emptyDerived().counts, link: 1 },
      total: 1,
    }

    const merged = withDelegations(derived, delegationContextItems([summary()]))

    expect(merged.items.map((i) => i.key)).toEqual(["delegation:dlg_1", "link:https://example.com"])
    expect(merged.counts.delegation).toBe(1)
    expect(merged.total).toBe(2)
  })

  it("returns the derived context untouched when there are no delegations", () => {
    const derived = emptyDerived()
    expect(withDelegations(derived, [])).toBe(derived)
  })
})
