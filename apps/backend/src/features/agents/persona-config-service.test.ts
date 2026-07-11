import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import type { ModelCapabilities, ModelRegistry } from "@threa/agent-runtime"
import { AgentToolNames, CompanionModes, MemoryModes, StreamPurposes, type PersonaConfigPatch } from "@threa/types"
import { PersonaConfigService } from "./persona-config-service"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { PersonaConfigRevisionRepository } from "./persona-config-revision-repository"
import { OutboxRepository } from "../../lib/outbox"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID } from "./built-in-agents"
import * as dbModule from "../../db"

const WORKSPACE_ID = "workspace_1"
const CALLER_ID = "usr_1"

// Minimal registry: two assignable chat models, plus an embedding and a realtime
// STT model that isChatModel must exclude from `availableModels` and assignment.
const FAKE_MODEL_CAPS: Record<string, ModelCapabilities> = {
  "openrouter:anthropic/claude-sonnet-5": {
    name: "Claude Sonnet 5",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
  },
  "openrouter:anthropic/claude-haiku-4.5": {
    name: "Claude Haiku 4.5",
    inputModalities: ["text"],
    outputModalities: ["text"],
  },
  "openrouter:openai/text-embedding-3-small": {
    name: "Text Embedding 3 Small",
    inputModalities: ["text"],
    outputModalities: ["embedding"],
  },
  "openrouter:elevenlabs/scribe": {
    name: "Scribe",
    inputModalities: ["audio"],
    outputModalities: ["text"],
    streaming: "realtime",
  },
}

const FAKE_MODEL_REGISTRY = {
  getModelIds: () => Object.keys(FAKE_MODEL_CAPS),
  getCapabilities: (id: string) => FAKE_MODEL_CAPS[id],
  isChatModel: (id: string) => {
    const caps = FAKE_MODEL_CAPS[id]
    return (
      caps !== undefined &&
      caps.inputModalities.includes("text") &&
      caps.outputModalities.includes("text") &&
      caps.streaming === undefined
    )
  },
} as unknown as ModelRegistry

function setupTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

function makeService(streamService: any = { getStreamById: mock(async (id: string) => ({ id, archivedAt: null })) }) {
  return new PersonaConfigService({ pool: {} as any, streamService, modelRegistry: FAKE_MODEL_REGISTRY })
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

  it("degrades a corrupt override to code defaults instead of failing the whole list", async () => {
    spyOn(AgentConfigOverrideRepository, "listActiveByWorkspace").mockResolvedValue([
      { agentId: ARIADNE_AGENT_ID, patch: { model: 42, bogus: true } },
    ])

    const personas = await makeService().listVisible(WORKSPACE_ID)

    expect(personas[0]).toMatchObject({ id: ARIADNE_AGENT_ID, name: "Ariadne", isCustomized: true })
  })
})

describe("PersonaConfigService.getConfig", () => {
  afterEach(() => mock.restore())

  it("returns defaults and a null draft when neither override nor draft exists", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(config).toMatchObject({
      overridePatch: null,
      overrideUpdatedAt: null,
      draft: null,
      resolved: { id: ARIADNE_AGENT_ID, model: config!.defaults.model },
    })
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

  it("returns registry-derived chat models as availableModels (excludes embeddings and realtime STT)", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(config!.availableModels).toEqual([
      { id: "openrouter:anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "openrouter:anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
    ])
  })
})

describe("PersonaConfigService.setOverride", () => {
  afterEach(() => mock.restore())

  it("an empty patch removes the override (restore-to-default): deletes, no revision, default persona", async () => {
    setupTransaction()
    const del = spyOn(AgentConfigOverrideRepository, "deleteActive").mockResolvedValue({ outcome: "deleted" })
    const upsert = spyOn(AgentConfigOverrideRepository, "upsertActive")
    const deleteDraft = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const revisionInsert = spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })

    const result = await makeService().setOverride(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      {},
      "2026-07-02T00:00:00.000Z",
      CALLER_ID
    )

    expect(result).toMatchObject({
      outcome: "written",
      updatedAt: null,
      persona: { isCustomized: false, name: "Ariadne" },
    })
    expect(del).toHaveBeenCalledWith(
      {},
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        expectedUpdatedAt: "2026-07-02T00:00:00.000Z",
      }
    )
    expect(upsert).not.toHaveBeenCalled()
    expect(revisionInsert).not.toHaveBeenCalled()
    expect(deleteDraft).toHaveBeenCalled()
    expect(insert).toHaveBeenCalledWith(
      {},
      "agent_config:updated",
      expect.objectContaining({ agentId: ARIADNE_AGENT_ID })
    )
  })

  it("surfaces a conflict from deleteActive on an empty-patch reset without broadcasting", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "deleteActive").mockResolvedValue({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: "2026-07-02T00:00:00.000Z" },
    })
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().setOverride(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      {},
      "2020-01-01T00:00:00.000Z",
      CALLER_ID
    )

    expect(result.outcome).toBe("conflict")
    expect(insert).not.toHaveBeenCalled()
  })

  it("writes the override, drops the caller's draft, and broadcasts in the same transaction", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
    const deleteDraft = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    const insert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const revisionInsert = spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })

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
    // A revision is appended on the same txn client (INV-7) capturing the committed patch.
    expect(revisionInsert).toHaveBeenCalledWith(
      {},
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        patch: { name: "Renamed", enabledTools: [AgentToolNames.SEND_MESSAGE] },
        createdByKind: "user",
        createdById: CALLER_ID,
      }
    )
  })

  it("archives the bound test stream after a successful save (session complete), tolerating archive failure", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue({ testStreamId: "stream_test" })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    const archiveStream = mock(async () => null)
    const service = new PersonaConfigService({
      pool: {} as any,
      streamService: { archiveStream } as any,
      modelRegistry: FAKE_MODEL_REGISTRY,
    })

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

  it("rejects a model outside the registry chat set with a 400 before opening a transaction", async () => {
    const upsert = spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })

    await expect(
      makeService().setOverride(
        WORKSPACE_ID,
        ARIADNE_AGENT_ID,
        { model: "openrouter:openai/text-embedding-3-small" },
        null,
        CALLER_ID
      )
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED_PERSONA_MODEL" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("accepts the built-in default model even when the registry lacks it (a code default stays assignable)", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })

    // Ariadne's default escalationModel (opus-4.8) is absent from FAKE_MODEL_REGISTRY.
    const result = await makeService().setOverride(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      { escalationModel: "openrouter:anthropic/claude-opus-4.8" },
      null,
      CALLER_ID
    )

    expect(result.outcome).toBe("written")
  })
})

describe("PersonaConfigService.listRevisions", () => {
  afterEach(() => mock.restore())

  it("returns the persona's revisions newest-first, stripping the internal agentId", async () => {
    const list = spyOn(PersonaConfigRevisionRepository, "listByWorkspaceAndAgent").mockResolvedValue([
      {
        id: "acrev_2",
        agentId: ARIADNE_AGENT_ID,
        version: 2,
        patch: { name: "V2" },
        createdByKind: "user",
        createdById: "usr_1",
        createdAt: "2026-07-05T00:00:00.000Z",
      },
    ])

    const revisions = await makeService().listRevisions(WORKSPACE_ID, ARIADNE_AGENT_ID)

    // Fetches cap+1 to detect exact truncation.
    expect(list).toHaveBeenCalledWith({}, WORKSPACE_ID, ARIADNE_AGENT_ID, 51)
    expect(revisions).toEqual([
      {
        id: "acrev_2",
        version: 2,
        patch: { name: "V2" },
        createdByKind: "user",
        createdById: "usr_1",
        createdAt: "2026-07-05T00:00:00.000Z",
      },
    ])
  })
})

describe("PersonaConfigService.restoreRevision", () => {
  afterEach(() => mock.restore())

  it("re-commits the revision's patch through setOverride, writing a NEW revision", async () => {
    setupTransaction()
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue({
      id: "acrev_1",
      agentId: ARIADNE_AGENT_ID,
      version: 1,
      patch: { name: "Original" },
      createdByKind: "user",
      createdById: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    const upsert = spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-06T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const revisionInsert = spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 5 })

    const result = await makeService().restoreRevision(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      "acrev_1",
      "2026-07-05T00:00:00.000Z",
      CALLER_ID
    )

    expect(result).toMatchObject({ outcome: "written", updatedAt: "2026-07-06T00:00:00.000Z" })
    // setOverride ran with the revision's patch and the caller's optimistic token.
    expect(upsert).toHaveBeenCalledWith(
      {},
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        patch: { name: "Original" },
        expectedUpdatedAt: "2026-07-05T00:00:00.000Z",
      }
    )
    // Restore appends its own revision — history stays append-only.
    expect(revisionInsert).toHaveBeenCalledWith(
      {},
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        patch: { name: "Original" },
        createdByKind: "user",
        createdById: CALLER_ID,
      }
    )
  })

  it("404s a revision foreign to the persona (belongs to another agent)", async () => {
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue({
      id: "acrev_9",
      agentId: "persona_system_other",
      version: 1,
      patch: { name: "Foreign" },
      createdByKind: "user",
      createdById: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    const upsert = spyOn(AgentConfigOverrideRepository, "upsertActive")

    await expect(
      makeService().restoreRevision(WORKSPACE_ID, ARIADNE_AGENT_ID, "acrev_9", null, CALLER_ID)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_REVISION_NOT_FOUND" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("404s a revision absent from the workspace", async () => {
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue(null)

    await expect(
      makeService().restoreRevision(WORKSPACE_ID, ARIADNE_AGENT_ID, "acrev_missing", null, CALLER_ID)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_REVISION_NOT_FOUND" })
  })

  it("422s a revision whose stored patch no longer validates (schema drift) instead of a raw 500", async () => {
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue({
      id: "acrev_old",
      agentId: ARIADNE_AGENT_ID,
      version: 1,
      // enabledTools carrying a since-retired tool name — the stored JSONB is
      // opaque, so this models a revision written before the enum changed.
      patch: { enabledTools: ["a_tool_that_was_removed"] } as unknown as PersonaConfigPatch,
      createdByKind: "user",
      createdById: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    const upsert = spyOn(AgentConfigOverrideRepository, "upsertActive")

    await expect(
      makeService().restoreRevision(WORKSPACE_ID, ARIADNE_AGENT_ID, "acrev_old", null, CALLER_ID)
    ).rejects.toMatchObject({ status: 422, code: "PERSONA_REVISION_INCOMPATIBLE" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("surfaces a 409 conflict from the underlying setOverride without writing a revision", async () => {
    setupTransaction()
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue({
      id: "acrev_1",
      agentId: ARIADNE_AGENT_ID,
      version: 1,
      patch: { name: "Original" },
      createdByKind: "user",
      createdById: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: "2026-07-06T00:00:00.000Z" },
    })
    const revisionInsert = spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 5 })

    const result = await makeService().restoreRevision(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      "acrev_1",
      "2026-07-05T00:00:00.000Z",
      CALLER_ID
    )

    expect(result).toEqual({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: "2026-07-06T00:00:00.000Z" },
    })
    expect(revisionInsert).not.toHaveBeenCalled()
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

  it("saveDraft rejects a model outside the registry chat set (same gate as the override)", async () => {
    const upsert = spyOn(PersonaConfigDraftRepository, "upsert").mockResolvedValue({
      patch: {},
      testStreamId: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    })

    await expect(
      makeService().saveDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID, {
        model: "openrouter:elevenlabs/scribe",
      })
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED_PERSONA_MODEL" })
    expect(upsert).not.toHaveBeenCalled()
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
    const service = new PersonaConfigService({
      pool: {} as any,
      streamService: { archiveStream } as any,
      modelRegistry: FAKE_MODEL_REGISTRY,
    })

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
    const service = new PersonaConfigService({
      pool: {} as any,
      streamService: { archiveStream } as any,
      modelRegistry: FAKE_MODEL_REGISTRY,
    })

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
    const service = new PersonaConfigService({
      pool: {} as any,
      streamService: { archiveStream } as any,
      modelRegistry: FAKE_MODEL_REGISTRY,
    })

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
      modelRegistry: FAKE_MODEL_REGISTRY,
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
      modelRegistry: FAKE_MODEL_REGISTRY,
    })

    const result = await service.ensureTestStream(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER_ID)

    expect(result).toEqual({ streamId: "stream_new" })
    expect(createScratchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        companionMode: CompanionModes.ON,
        companionPersonaId: ARIADNE_AGENT_ID,
        memoryMode: MemoryModes.OFF,
        // Marked as a workbench so it never enters the sidebar/workspace lists.
        purpose: StreamPurposes.PERSONA_TEST,
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

  it("ensureTestStream binds via the single-statement bindTestStream, never touching the patch", async () => {
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
      modelRegistry: FAKE_MODEL_REGISTRY,
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
