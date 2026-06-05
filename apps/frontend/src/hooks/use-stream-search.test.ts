import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { collectLocalMatches, useStreamSearch, type SearchContentResolver } from "./use-stream-search"
import type { CachedEvent } from "@/db"
import * as dbModule from "@/db"
import * as decryptCache from "@/lib/crypto/decrypt-cache"
import * as e2eStore from "@/stores/e2e-session-store"
import * as api from "@/api"

function event(overrides: Partial<CachedEvent> & { id: string; _sequenceNum: number }): CachedEvent {
  return {
    workspaceId: "ws_1",
    streamId: "stream_1",
    sequence: String(overrides._sequenceNum),
    eventType: "message_created",
    payload: {},
    actorId: "usr_1",
    actorType: "user",
    createdAt: new Date(overrides._sequenceNum * 1000).toISOString(),
    _cachedAt: 0,
    ...overrides,
  } as CachedEvent
}

/** Plaintext resolver: bare contentMarkdown off the payload. */
const plaintext: SearchContentResolver = (e) => {
  const p = e.payload as { contentMarkdown?: string }
  return Promise.resolve(typeof p.contentMarkdown === "string" ? p.contentMarkdown : null)
}

describe("collectLocalMatches", () => {
  it("matches plaintext bodies case-insensitively and returns chronological order", async () => {
    const events = [
      event({ id: "e2", _sequenceNum: 2, payload: { messageId: "m2", contentMarkdown: "the Quick brown fox" } }),
      event({ id: "e1", _sequenceNum: 1, payload: { messageId: "m1", contentMarkdown: "a quick note" } }),
      event({ id: "e3", _sequenceNum: 3, payload: { messageId: "m3", contentMarkdown: "nothing here" } }),
    ]

    const matches = await collectLocalMatches(events, "QUICK", plaintext)

    expect(matches.map((m) => m.id)).toEqual(["m1", "m2"]) // sorted by _sequenceNum, m3 excluded
    expect(matches[0]).toMatchObject({ id: "m1", streamId: "stream_1", content: "a quick note", authorType: "user" })
  })

  it("matches DECRYPTED bodies for sealed rows (the E2E path)", async () => {
    // Sealed rows carry only a zero-width placeholder on the wire; the resolver
    // returns the decrypted body, which is what search must match against.
    const plain = "​" // E2E placeholder
    const events = [
      event({
        id: "e1",
        _sequenceNum: 1,
        payload: { messageId: "m1", contentMarkdown: plain, ciphertext: "ct", envelope: { v: 2 } },
      }),
    ]
    const decrypted: Record<string, string> = { e1: "the launch codename is VELVET-OTTER" }
    const resolver: SearchContentResolver = (e) => Promise.resolve(decrypted[e.id] ?? null)

    const matches = await collectLocalMatches(events, "velvet-otter", resolver)

    expect(matches).toEqual([expect.objectContaining({ id: "m1", content: "the launch codename is VELVET-OTTER" })])
  })

  it("never matches the placeholder when a sealed row can't be decrypted (locked → null)", async () => {
    const placeholder = "​"
    const events = [
      event({
        id: "e1",
        _sequenceNum: 1,
        payload: { messageId: "m1", contentMarkdown: placeholder, ciphertext: "ct", envelope: { v: 2 } },
      }),
    ]
    // Locked/undecryptable rows resolve to null and are skipped entirely.
    const lockedResolver: SearchContentResolver = () => Promise.resolve(null)

    // Even searching for the placeholder character yields nothing — we never
    // match server-side ciphertext/placeholder, only decrypted content.
    expect(await collectLocalMatches(events, placeholder, lockedResolver)).toEqual([])
    expect(await collectLocalMatches(events, "anything", lockedResolver)).toEqual([])
  })

  it("falls back to the event id when the payload has no messageId", async () => {
    const events = [event({ id: "evt_x", _sequenceNum: 1, payload: { contentMarkdown: "findme" } })]
    const matches = await collectLocalMatches(events, "findme", plaintext)
    expect(matches[0].id).toBe("evt_x")
  })
})

// Integration: exercise the real hook wiring (session → resolver →
// requestDecryption → search orchestration → e2e server-phase skip), mocking
// only the boundaries (IDB, decrypt cache, session, server search).
describe("useStreamSearch hook integration", () => {
  let fakeEvents: CachedEvent[]
  let searchMessagesSpy: ReturnType<typeof vi.spyOn>

  function mockEventsTable(events: CachedEvent[]) {
    // db.events.where(...).equals(...).filter(pred).toArray()
    const chain = {
      equals: () => chain,
      filter: (pred: (e: CachedEvent) => boolean) => ({ toArray: async () => events.filter(pred) }),
    }
    vi.spyOn(dbModule.db.events, "where").mockReturnValue(chain as never)
  }

  beforeEach(() => {
    fakeEvents = []
    vi.spyOn(e2eStore, "useE2eSession").mockReturnValue({
      status: "unlocked",
      privateKey: {} as CryptoKey,
      keyId: "e2ek_self",
    } as never)
    searchMessagesSpy = vi.spyOn(api, "searchMessages").mockResolvedValue({ results: [] } as never)
  })

  afterEach(() => vi.restoreAllMocks())

  it("decrypts sealed rows on demand and matches their plaintext; skips the server phase", async () => {
    fakeEvents = [
      event({
        id: "e1",
        _sequenceNum: 1,
        payload: { messageId: "m1", contentMarkdown: "​", ciphertext: "ct1", envelope: { v: 2 } },
      }),
      event({
        id: "e2",
        _sequenceNum: 2,
        payload: { messageId: "m2", contentMarkdown: "​", ciphertext: "ct2", envelope: { v: 2 } },
      }),
    ]
    mockEventsTable(fakeEvents)
    const decryptedById: Record<string, string> = {
      e1: "the codename is VELVET-OTTER",
      e2: "unrelated chatter",
    }
    vi.spyOn(decryptCache, "requestDecryption").mockImplementation(
      async (eventId: string) =>
        ({ status: "decrypted", content: { contentMarkdown: decryptedById[eventId] ?? "" } }) as never
    )

    const { result } = renderHook(() =>
      useStreamSearch({ workspaceId: "ws_1", streamId: "stream_1", e2eEnabled: true, userId: "usr_self" })
    )

    await act(async () => {
      result.current.setQuery("velvet-otter")
    })
    await act(async () => {
      await result.current.search()
    })

    // Matched the DECRYPTED body of the sealed row…
    expect(result.current.results.map((r) => r.id)).toEqual(["m1"])
    expect(result.current.results[0].content).toContain("VELVET-OTTER")
    // …and never hit the server ILIKE phase (it can only match the placeholder).
    expect(searchMessagesSpy).not.toHaveBeenCalled()
  })

  it("plaintext stream still calls the server phase (no behavior change)", async () => {
    fakeEvents = [
      event({ id: "e1", _sequenceNum: 1, payload: { messageId: "m1", contentMarkdown: "hello plaintext" } }),
    ]
    mockEventsTable(fakeEvents)

    const { result } = renderHook(() =>
      useStreamSearch({ workspaceId: "ws_1", streamId: "stream_1", e2eEnabled: false })
    )

    await act(async () => {
      result.current.setQuery("plaintext")
    })
    await act(async () => {
      await result.current.search()
    })

    expect(result.current.results.map((r) => r.id)).toEqual(["m1"])
    expect(searchMessagesSpy).toHaveBeenCalledTimes(1)
  })
})
