import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import { db, type CachedPersona, type CachedWorkspaceMetadata, type CachedWorkspaceUser } from "@/db"
import * as emojiPicker from "@/lib/emoji-picker"
import * as perfCapture from "@/lib/perf/capture"
import { useActors } from "@/hooks/use-actors"
import { useWorkspaceStreams, resetWorkspaceStoreCache, upsertWorkspacePersonaCache } from "./workspace-store"
import { resetActorLookups } from "./actor-lookup"
import { resetWorkspaceTableRegistry, setWorkspaceReadMode } from "./workspace-table-registry"

const WORKSPACE = "ws_1"

function makeUser(id: string, name: string): CachedWorkspaceUser {
  return {
    id,
    workspaceId: WORKSPACE,
    workosUserId: `workos_${id}`,
    email: `${id}@example.com`,
    role: "member",
    slug: id,
    name,
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    setupCompleted: true,
    joinedAt: "2026-03-01T10:00:00Z",
    _cachedAt: 1,
  }
}

function makePersona(id: string, name: string): CachedPersona {
  return {
    id,
    workspaceId: WORKSPACE,
    slug: name.toLowerCase(),
    name,
    description: null,
    avatarEmoji: null,
    avatarUrl: null,
    systemPrompt: null,
    model: "claude-sonnet-4-20250514",
    temperature: null,
    maxTokens: null,
    enabledTools: null,
    managedBy: "system",
    ownerUserId: null,
    status: "active",
    createdAt: "2026-03-01T10:00:00Z",
    updatedAt: "2026-03-01T10:00:00Z",
    _cachedAt: 1,
  }
}

function makeMetadata(): CachedWorkspaceMetadata {
  return {
    id: WORKSPACE,
    workspaceId: WORKSPACE,
    emojis: [
      { shortcode: "smile", emoji: "😄", type: "unicode", group: "people", order: 1, aliases: ["grin"] },
      { shortcode: "thread", emoji: "🧵", type: "unicode", group: "objects", order: 2, aliases: [] },
    ],
    emojiWeights: {},
    _cachedAt: 1,
  } as CachedWorkspaceMetadata
}

function ManyActorConsumers({ count }: { count: number }) {
  const lookups = []
  for (let i = 0; i < count; i++) {
    lookups.push(useActors(WORKSPACE))
  }
  return <div data-testid="name">{lookups[0].getActorName("usr_1", "user")}</div>
}

function TwoConsumers({ tick, seen }: { tick: number; seen: Array<[unknown, unknown]> }) {
  const first = useActors(WORKSPACE)
  const second = useActors(WORKSPACE)
  seen.push([first, second])
  return (
    <div data-testid="name">
      {first.getActorName("usr_1", "user")}-{second.getActorName("usr_1", "user")}-{tick}
    </div>
  )
}

describe("actor lookup", () => {
  beforeEach(async () => {
    resetWorkspaceTableRegistry()
    resetWorkspaceStoreCache()
    resetActorLookups()
    await db.workspaceUsers.clear()
    await db.personas.clear()
    await db.bots.clear()
    await db.workspaceMetadata.clear()
    await db.streams.clear()
    setWorkspaceReadMode("shared")
  })

  afterEach(() => {
    resetWorkspaceTableRegistry()
    resetActorLookups()
    vi.restoreAllMocks()
  })

  it("the emoji shortcode index is built once for twenty useActors consumers", async () => {
    await db.workspaceUsers.put(makeUser("usr_1", "Ada"))
    await db.workspaceMetadata.put(makeMetadata())
    const build = vi.spyOn(emojiPicker, "buildShortcodeIndex")

    const { findByText } = render(<ManyActorConsumers count={20} />)
    await findByText("Ada")

    expect(build).toHaveBeenCalledTimes(1)
  })

  it("the ActorLookup identity is stable when unrelated workspace data changes", async () => {
    await db.workspaceUsers.put(makeUser("usr_1", "Ada"))
    await db.workspaceMetadata.put(makeMetadata())
    const { result } = renderHook(() => ({
      lookup: useActors(WORKSPACE),
      streams: useWorkspaceStreams(WORKSPACE),
    }))
    await waitFor(() => expect(result.current.lookup.getActorName("usr_1", "user")).toBe("Ada"))
    const before = result.current.lookup

    await act(async () => {
      await db.streams.put({
        id: "stream_1",
        workspaceId: WORKSPACE,
        type: "channel",
        slug: "general",
        displayName: null,
        _cachedAt: 1,
      } as never)
    })
    await waitFor(() => expect(result.current.streams).toHaveLength(1))

    expect(result.current.lookup).toBe(before)
  })

  it("the identity changes when a user's name changes, and the new name resolves", async () => {
    await db.workspaceUsers.put(makeUser("usr_1", "Ada"))
    await db.workspaceMetadata.put(makeMetadata())
    const { result } = renderHook(() => useActors(WORKSPACE))
    await waitFor(() => expect(result.current.getActorName("usr_1", "user")).toBe("Ada"))
    const before = result.current

    await act(async () => {
      await db.workspaceUsers.put(makeUser("usr_1", "Ada Lovelace"))
    })
    await waitFor(() => expect(result.current.getActorName("usr_1", "user")).toBe("Ada Lovelace"))

    expect(result.current).not.toBe(before)
  })

  it("a persona added by upsertWorkspacePersonaCache is visible without a bootstrap", async () => {
    await db.workspaceMetadata.put(makeMetadata())
    const { result } = renderHook(() => useActors(WORKSPACE))
    await waitFor(() => expect(result.current.getActorName("persona_1", "persona")).toBe("AI Companion"))

    await act(async () => {
      upsertWorkspacePersonaCache(WORKSPACE, makePersona("persona_1", "Ariadne"))
    })

    await waitFor(() => expect(result.current.getActorName("persona_1", "persona")).toBe("Ariadne"))
  })

  it("each consumer keeps its own lookup identity across a re-render when sharing is off", async () => {
    setWorkspaceReadMode("off")
    await db.workspaceUsers.put(makeUser("usr_1", "Ada"))
    await db.workspaceMetadata.put(makeMetadata())
    const seen: Array<[unknown, unknown]> = []

    const { findByText, rerender } = render(<TwoConsumers tick={0} seen={seen} />)
    await findByText("Ada-Ada-0")
    rerender(<TwoConsumers tick={1} seen={seen} />)
    await findByText("Ada-Ada-1")
    const [firstBefore, secondBefore] = seen[seen.length - 1]

    rerender(<TwoConsumers tick={2} seen={seen} />)
    await findByText("Ada-Ada-2")
    const [firstAfter, secondAfter] = seen[seen.length - 1]

    expect({
      firstStable: firstAfter === firstBefore,
      secondStable: secondAfter === secondBefore,
    }).toEqual({ firstStable: true, secondStable: true })
  })

  it("the lookup build count is bounded by the consumer count and does not grow on re-render", async () => {
    setWorkspaceReadMode("off")
    await db.workspaceUsers.put(makeUser("usr_1", "Ada"))
    await db.workspaceMetadata.put(makeMetadata())
    const time = vi.fn((_name: string) => () => {})
    vi.spyOn(perfCapture, "getPerfCapture").mockReturnValue({
      time,
      mark: () => {},
      count: () => {},
    } as unknown as ReturnType<typeof perfCapture.getPerfCapture>)
    const builds = () => time.mock.calls.filter(([name]) => name === "actors.lookupBuild").length

    const seen: Array<[unknown, unknown]> = []
    const { findByText, rerender } = render(<TwoConsumers tick={0} seen={seen} />)
    await findByText("Ada-Ada-0")
    rerender(<TwoConsumers tick={1} seen={seen} />)
    await findByText("Ada-Ada-1")
    const settled = builds()

    rerender(<TwoConsumers tick={2} seen={seen} />)
    await findByText("Ada-Ada-2")

    // One sample per emoji-index build (the only producer): two consumers each
    // build their own while the rows resolve — a per-consumer constant, not a
    // per-render one.
    expect({ settled, grew: builds() - settled }).toEqual({ settled, grew: 0 })
    // One emoji-index build per consumer, and nothing else samples this timer.
    expect(settled).toBe(2)
  })

  it("an unknown actor id falls back exactly as before", async () => {
    await db.workspaceMetadata.put(makeMetadata())
    const { result } = renderHook(() => useActors(WORKSPACE))
    await waitFor(() => expect(result.current.getActorName(null, null)).toBe("Unknown"))

    expect({
      persona: result.current.getActorName("persona_missing", "persona"),
      bot: result.current.getActorName("bot_missing", "bot"),
      user: result.current.getActorName("usr_abcdefghij", "user"),
      systemName: result.current.getActorName("usr_1", "system"),
      personaInitials: result.current.getActorInitials("persona_missing", "persona"),
      botInitials: result.current.getActorInitials("bot_missing", "bot"),
      userInitials: result.current.getActorInitials("usr_abcdefghij", "user"),
      nullInitials: result.current.getActorInitials(null, null),
      avatar: result.current.getActorAvatar("usr_abcdefghij", "user"),
    }).toEqual({
      persona: "AI Companion",
      bot: "Bot",
      user: "usr_abcd",
      systemName: "Threa",
      personaInitials: "AI",
      botInitials: "B",
      userInitials: "US",
      nullInitials: "?",
      avatar: { fallback: "US" },
    })
  })
})
