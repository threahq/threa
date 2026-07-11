import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { AgentToolNames, CompanionModes, MemoryModes } from "@threa/types"
import { PersonaConfigService } from "./persona-config-service"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { OutboxRepository } from "../../lib/outbox"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID } from "./built-in-agents"
import * as dbModule from "../../db"

const WORKSPACE_ID = "workspace_1"
const CALLER_ID = "usr_1"

function setupTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

function makeService(streamService: any = { getStreamById: mock(async (id: string) => ({ id, archivedAt: null })) }) {
  return new PersonaConfigService({ pool: {} as any, streamService })
}

describe("PersonaConfigService.listVisible", () => {
  afterEach(() => mock.restore())

  it("lists Ariadne as not-customized when no override exists", async () => {
    spyOn(AgentConfigOverrideRepository, "listActiveByWorkspace").mockResolvedValue([])

    const personas = await makeService().listVisible(WORKSPACE_ID)

    expect(personas).toHaveLength(1)
    expect(personas[0]).toMatchObject({ id: ARIADNE_AGENT_ID, slug: "ariadne", name: "Ariadne", isCustomized: false })
    expect(personas[0]).not.toHaveProperty("systemPrompt")
  })

  it("resolves the override and flags the persona customized", async () => {
    spyOn(AgentConfigOverrideRepository, "listActiveByWorkspace").mockResolvedValue([
      { agentId: ARIADNE_AGENT_ID, patch: { name: "Custom Ariadne" } },
    ])

    const personas = await makeService().listVisible(WORKSPACE_ID)

    expect(personas[0]).toMatchObject({ id: ARIADNE_AGENT_ID, name: "Custom Ariadne", isCustomized: true })
  })
})

describe("PersonaConfigService.getConfig", () => {
  afterEach(() => mock.restore())

  it("returns defaults and a null draft when neither override nor draft exists", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(config).not.toBeNull()
    expect(config!.overridePatch).toBeNull()
    expect(config!.overrideUpdatedAt).toBeNull()
    expect(config!.draft).toBeNull()
    expect(config!.defaults.model).toBe(config!.resolved.model)
    expect(config!.resolved.id).toBe(ARIADNE_AGENT_ID)
  })

  it("applies the override patch to the resolved config", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue({
      patch: { model: "openrouter:anthropic/claude-haiku-4.5" },
      updatedAt: "2026-07-01T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(config!.overridePatch).toEqual({ model: "openrouter:anthropic/claude-haiku-4.5" })
    expect(config!.overrideUpdatedAt).toBe("2026-07-01T00:00:00.000Z")
    expect(config!.resolved.model).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(config!.defaults.model).toBe("openrouter:anthropic/claude-sonnet-5")
  })

  it("returns the caller's own draft (validated, no status) alongside the resolved config", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue({
      patch: { name: "Draft Ariadne" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-03T00:00:00.000Z",
    })

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(config!.draft).toEqual({
      patch: { name: "Draft Ariadne" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-03T00:00:00.000Z",
    })
  })

  it("nulls the draft's testStreamId when the bound stream is archived or gone (End is durable across reload)", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue({
      patch: { name: "Draft Ariadne" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-03T00:00:00.000Z",
    })

    const archived = makeService({
      getStreamById: mock(async () => ({ id: "stream_test", archivedAt: "2026-07-03T01:00:00.000Z" })),
    })
    expect((await archived.getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID))!.draft).toEqual({
      patch: { name: "Draft Ariadne" },
      testStreamId: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    })

    const gone = makeService({ getStreamById: mock(async () => null) })
    expect((await gone.getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID))!.draft!.testStreamId).toBeNull()
  })

  it("returns null (→ 404) for the internal empty shell and unknown ids", async () => {
    const service = makeService()
    expect(await service.getConfig(WORKSPACE_ID, EMPTY_AGENT_ID, CALLER_ID)).toBeNull()
    expect(await service.getConfig(WORKSPACE_ID, "persona_system_missing", CALLER_ID)).toBeNull()
  })
})

describe("PersonaConfigService.setOverride", () => {
  afterEach(() => mock.restore())

  it("writes the override, drops the caller's draft, and broadcasts in the same transaction", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
    const deleteDraft = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().setOverride(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      { name: "Renamed", enabledTools: [AgentToolNames.SEND_MESSAGE] },
      null,
      CALLER_ID
    )

    expect(result).toEqual({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
      persona: {
        id: ARIADNE_AGENT_ID,
        slug: "ariadne",
        name: "Renamed",
        description: expect.any(String),
        avatarEmoji: ":thread:",
        model: "openrouter:anthropic/claude-sonnet-5",
        isCustomized: true,
      },
    })
    // Draft dropped on the same client the override wrote through (the txn).
    expect(deleteDraft).toHaveBeenCalledWith({}, WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)
    expect(insert).toHaveBeenCalledWith({}, "agent_config:updated", {
      workspaceId: WORKSPACE_ID,
      agentId: ARIADNE_AGENT_ID,
      persona: result.outcome === "written" ? result.persona : undefined,
    })
  })

  it("archives the bound test stream after a successful save (session complete), tolerating archive failure", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue({ testStreamId: "stream_test" })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const archiveStream = mock(async () => null)
    const service = new PersonaConfigService({ pool: {} as any, streamService: { archiveStream } as any })

    const result = await service.setOverride(WORKSPACE_ID, ARIADNE_AGENT_ID, { name: "Renamed" }, null, CALLER_ID)

    expect(result.outcome).toBe("written")
    expect("testStreamId" in result).toBe(false)
    expect(archiveStream).toHaveBeenCalledWith("stream_test", CALLER_ID)

    // A failed archive must not fail the save — the override is already committed.
    archiveStream.mockImplementation(async () => {
      throw new Error("archive failed")
    })
    const second = await service.setOverride(WORKSPACE_ID, ARIADNE_AGENT_ID, { name: "Renamed" }, null, CALLER_ID)
    expect(second.outcome).toBe("written")
  })

  it("returns the conflict without dropping the draft or broadcasting when the optimistic check fails", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: "2026-07-02T00:00:00.000Z" },
    })
    const deleteDraft = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().setOverride(WORKSPACE_ID, ARIADNE_AGENT_ID, { name: "Mine" }, null, CALLER_ID)

    expect(result).toEqual({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: "2026-07-02T00:00:00.000Z" },
    })
    expect(deleteDraft).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })
})

describe("PersonaConfigService draft lifecycle", () => {
  afterEach(() => mock.restore())

  it("saveDraft upserts and echoes the saved state", async () => {
    spyOn(PersonaConfigDraftRepository, "upsert").mockResolvedValue({
      patch: { name: "Draft" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-04T00:00:00.000Z",
    })

    const draft = await makeService().saveDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID, { name: "Draft" })

    expect(draft).toEqual({
      patch: { name: "Draft" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
  })

  it("discardDraft archives the bound test stream before deleting the draft row", async () => {
    const order: string[] = []
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue({
      patch: {},
      testStreamId: "stream_test",
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
    const deleteByOwner = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockImplementation(async () => {
      order.push("delete")
      return { testStreamId: "stream_test" }
    })
    const archiveStream = mock(async () => {
      order.push("archive")
      return null
    })
    const service = new PersonaConfigService({ pool: {} as any, streamService: { archiveStream } as any })

    await service.discardDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(archiveStream).toHaveBeenCalledWith("stream_test", CALLER_ID)
    expect(deleteByOwner).toHaveBeenCalledWith({}, WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)
    // Archive first so a failed archive leaves the pointer to retry, never orphans.
    expect(order).toEqual(["archive", "delete"])
  })

  it("discardDraft is a no-op when there is no draft", async () => {
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)
    const deleteByOwner = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    const archiveStream = mock(async () => null)
    const service = new PersonaConfigService({ pool: {} as any, streamService: { archiveStream } as any })

    await service.discardDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(archiveStream).not.toHaveBeenCalled()
    expect(deleteByOwner).not.toHaveBeenCalled()
  })

  it("discardDraft deletes a draft that has no bound test stream without archiving", async () => {
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue({
      patch: {},
      testStreamId: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
    const deleteByOwner = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue({ testStreamId: null })
    const archiveStream = mock(async () => null)
    const service = new PersonaConfigService({ pool: {} as any, streamService: { archiveStream } as any })

    await service.discardDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(archiveStream).not.toHaveBeenCalled()
    expect(deleteByOwner).toHaveBeenCalledWith({}, WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)
  })

  it("ensureTestStream returns the existing active bound stream without creating a new one", async () => {
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue({
      patch: {},
      testStreamId: "stream_existing",
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
    const getStreamById = mock(async () => ({ id: "stream_existing", archivedAt: null }))
    const createScratchpad = mock(async () => ({ id: "stream_new" }))
    const service = new PersonaConfigService({
      pool: {} as any,
      streamService: { getStreamById, createScratchpad } as any,
    })

    const result = await service.ensureTestStream(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(result).toEqual({ streamId: "stream_existing" })
    expect(createScratchpad).not.toHaveBeenCalled()
  })

  it("ensureTestStream creates a memory-off companion scratchpad and binds it when none is active", async () => {
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue({
      patch: {},
      testStreamId: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
    const bindTestStream = spyOn(PersonaConfigDraftRepository, "bindTestStream").mockResolvedValue()
    const createScratchpad = mock(async () => ({ id: "stream_new" }))
    const service = new PersonaConfigService({
      pool: {} as any,
      streamService: { getStreamById: mock(async () => null), createScratchpad } as any,
    })

    const result = await service.ensureTestStream(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(result).toEqual({ streamId: "stream_new" })
    expect(createScratchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        companionMode: CompanionModes.ON,
        companionPersonaId: ARIADNE_AGENT_ID,
        memoryMode: MemoryModes.OFF,
        createdBy: CALLER_ID,
        displayName: "Ariadne draft test",
      })
    )
    expect(bindTestStream).toHaveBeenCalledWith(
      {},
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        createdBy: CALLER_ID,
        testStreamId: "stream_new",
      }
    )
  })

  it("ensureTestStream binds via the upsert with no separate draft write when the editor hasn't saved yet", async () => {
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)
    const upsert = spyOn(PersonaConfigDraftRepository, "upsert").mockResolvedValue({
      patch: {},
      testStreamId: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
    const bindTestStream = spyOn(PersonaConfigDraftRepository, "bindTestStream").mockResolvedValue()
    const createScratchpad = mock(async () => ({ id: "stream_new" }))
    const service = new PersonaConfigService({
      pool: {} as any,
      streamService: { getStreamById: mock(async () => null), createScratchpad } as any,
    })

    const result = await service.ensureTestStream(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(result).toEqual({ streamId: "stream_new" })
    // No empty-patch upsert (INV-20): binding is the only draft write, and it never
    // touches patch, so a concurrent real saveDraft can't be clobbered back to {}.
    expect(upsert).not.toHaveBeenCalled()
    expect(bindTestStream).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, agentId: ARIADNE_AGENT_ID, createdBy: CALLER_ID, testStreamId: "stream_new" }
    )
  })
})
