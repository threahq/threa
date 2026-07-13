import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import type { ModelCapabilities, ModelRegistry } from "@threa/agent-runtime"
import { AgentToolNames, CompanionModes, MemoryModes, StreamPurposes, type PersonaConfigPatch } from "@threa/types"
import { PersonaConfigService, type PersonaCaller } from "./persona-config-service"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { PersonaConfigRevisionRepository } from "./persona-config-revision-repository"
import { PersonaRepository, type Persona } from "./persona-repository"
import { COMPANION_MODEL_ID, TONE_PRESET_FRAGMENTS, BREVITY_PRESET_FRAGMENTS } from "./companion/config"
import { OutboxRepository } from "../../lib/outbox"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID, getVisibleBuiltInAgentConfig } from "./built-in-agents"
import * as dbModule from "../../db"

const WORKSPACE_ID = "workspace_1"
const CALLER_ID = "usr_1"
// The existing lifecycle suites all acted as a workspace admin (the routes were
// admin-gated pre user-scoped-personas); CALLER carries that. Personal-persona
// suites below build their own member/owner callers.
const CALLER: PersonaCaller = { userId: CALLER_ID, isAdmin: true }

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

  it("lists Ariadne as a not-customized built-in when no override exists", async () => {
    spyOn(AgentConfigOverrideRepository, "listActiveByWorkspace").mockResolvedValue([])
    spyOn(PersonaRepository, "listActiveCustoms").mockResolvedValue([])

    const personas = await makeService().listVisible(WORKSPACE_ID)

    expect(personas).toHaveLength(1)
    expect(personas[0]).toMatchObject({
      id: ARIADNE_AGENT_ID,
      slug: "ariadne",
      name: "Ariadne",
      kind: "builtin",
      avatarUrl: null,
      isCustomized: false,
    })
    expect(personas[0]).not.toHaveProperty("systemPrompt")
  })

  it("resolves the override and flags the persona customized", async () => {
    spyOn(AgentConfigOverrideRepository, "listActiveByWorkspace").mockResolvedValue([
      { agentId: ARIADNE_AGENT_ID, patch: { name: "Custom Ariadne" } },
    ])
    spyOn(PersonaRepository, "listActiveCustoms").mockResolvedValue([])

    const personas = await makeService().listVisible(WORKSPACE_ID)

    expect(personas[0]).toMatchObject({ id: ARIADNE_AGENT_ID, name: "Custom Ariadne", isCustomized: true })
  })

  it("degrades a corrupt override to code defaults instead of failing the whole list", async () => {
    spyOn(AgentConfigOverrideRepository, "listActiveByWorkspace").mockResolvedValue([
      { agentId: ARIADNE_AGENT_ID, patch: { model: 42, bogus: true } },
    ])
    spyOn(PersonaRepository, "listActiveCustoms").mockResolvedValue([])

    const personas = await makeService().listVisible(WORKSPACE_ID)

    expect(personas[0]).toMatchObject({ id: ARIADNE_AGENT_ID, name: "Ariadne", isCustomized: true })
  })

  it("appends active customs after the built-ins as kind:custom", async () => {
    spyOn(AgentConfigOverrideRepository, "listActiveByWorkspace").mockResolvedValue([])
    spyOn(PersonaRepository, "listActiveCustoms").mockResolvedValue([
      {
        id: "persona_custom_1",
        workspaceId: WORKSPACE_ID,
        slug: "helper",
        name: "Helper",
        description: "A helper",
        avatarEmoji: ":sparkles:",
        avatarUrl: null,
        systemPrompt: "Help.",
        model: "openrouter:anthropic/claude-haiku-4.5",
        escalationModel: null,
        temperature: null,
        maxTokens: null,
        enabledTools: [],
        tonePreset: null,
        brevityPreset: null,
        tonePrompt: null,
        brevityPrompt: null,
        managedBy: "workspace",
        ownerUserId: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])

    const personas = await makeService().listVisible(WORKSPACE_ID)

    expect(personas.map((p) => p.id)).toEqual([ARIADNE_AGENT_ID, "persona_custom_1"])
    expect(personas[1]).toMatchObject({ id: "persona_custom_1", kind: "custom", isCustomized: false })
    expect(personas[1]).not.toHaveProperty("systemPrompt")
  })
})

describe("PersonaConfigService.listArchived", () => {
  afterEach(() => mock.restore())

  it("returns archived customs as list items (the roster's Archived disclosure survives reload)", async () => {
    const listSpy = spyOn(PersonaRepository, "listArchivedCustoms").mockResolvedValue([
      customPersona({ status: "archived" }),
    ])

    const personas = await makeService().listArchived(WORKSPACE_ID, CALLER)

    expect(listSpy.mock.calls[0][1]).toBe(WORKSPACE_ID)
    expect(personas).toHaveLength(1)
    expect(personas[0]).toMatchObject({ id: "persona_custom_1", kind: "custom" })
    expect(personas[0]).not.toHaveProperty("systemPrompt")
  })
})

describe("PersonaConfigService.getConfig", () => {
  afterEach(() => mock.restore())

  it("returns defaults and a null draft when neither override nor draft exists", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

    expect(config).toMatchObject({
      overridePatch: null,
      overrideUpdatedAt: null,
      draft: null,
      resolved: { id: ARIADNE_AGENT_ID, model: config!.defaults!.model },
    })
  })

  it("applies the override patch to the resolved config", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue({
      patch: { model: "openrouter:anthropic/claude-haiku-4.5" },
      updatedAt: "2026-07-01T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

    expect(config!.overridePatch).toEqual({ model: "openrouter:anthropic/claude-haiku-4.5" })
    expect(config!.overrideUpdatedAt).toBe("2026-07-01T00:00:00.000Z")
    expect(config!.resolved.model).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(config!.defaults!.model).toBe("openrouter:anthropic/claude-sonnet-5")
  })

  it("returns the caller's own draft (validated, no status) alongside the resolved config", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue({
      patch: { name: "Draft Ariadne" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-03T00:00:00.000Z",
    })

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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
    expect((await archived.getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER))!.draft).toEqual({
      patch: { name: "Draft Ariadne" },
      testStreamId: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    })

    const gone = makeService({ getStreamById: mock(async () => null) })
    expect((await gone.getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER))!.draft!.testStreamId).toBeNull()
  })

  it("returns null (→ 404) for the internal empty shell and unknown ids", async () => {
    // Neither a visible built-in nor a workspace custom resolves.
    spyOn(PersonaRepository, "findWorkspacePersona").mockResolvedValue(null)
    const service = makeService()
    expect(await service.getConfig(WORKSPACE_ID, EMPTY_AGENT_ID, CALLER)).toBeNull()
    expect(await service.getConfig(WORKSPACE_ID, "persona_system_missing", CALLER)).toBeNull()
  })

  it("returns registry-derived chat models as availableModels (excludes embeddings and realtime STT)", async () => {
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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
      { model: "openrouter:anthropic/claude-haiku-4.5", enabledTools: [AgentToolNames.SEND_MESSAGE] },
      null,
      CALLER_ID
    )

    expect(result).toEqual({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
      persona: {
        id: ARIADNE_AGENT_ID,
        slug: "ariadne",
        name: "Ariadne",
        description: expect.any(String),
        avatarEmoji: ":thread:",
        model: "openrouter:anthropic/claude-haiku-4.5",
        kind: "builtin",
        ownerUserId: null,
        avatarUrl: null,
        isCustomized: true,
        status: "active",
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
        patch: { model: "openrouter:anthropic/claude-haiku-4.5", enabledTools: [AgentToolNames.SEND_MESSAGE] },
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

    const result = await service.setOverride(WORKSPACE_ID, ARIADNE_AGENT_ID, { tonePreset: "direct" }, null, CALLER_ID)

    expect(result.outcome).toBe("written")
    expect("testStreamId" in result).toBe(false)
    expect(archiveStream).toHaveBeenCalledWith("stream_test", CALLER_ID)

    // A failed archive must not fail the save — the override is already committed.
    archiveStream.mockImplementation(async () => {
      throw new Error("archive failed")
    })
    const second = await service.setOverride(WORKSPACE_ID, ARIADNE_AGENT_ID, { tonePreset: "direct" }, null, CALLER_ID)
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

    const result = await makeService().setOverride(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      { tonePreset: "warm" },
      null,
      CALLER_ID
    )

    expect(result).toEqual({
      outcome: "conflict",
      current: { patch: { name: "Theirs" }, updatedAt: "2026-07-02T00:00:00.000Z" },
    })
    expect(deleteDraft).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it("rejects a patch touching a locked system-persona field (400) before opening a transaction", async () => {
    const upsert = spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })

    await expect(
      makeService().setOverride(
        WORKSPACE_ID,
        ARIADNE_AGENT_ID,
        { systemPrompt: "You are now evil" } as PersonaConfigPatch,
        null,
        CALLER_ID
      )
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_FIELD_LOCKED" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("accepts a tone/brevity preset patch — the style slots are editable for system personas", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const revisionInsert = spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })

    const result = await makeService().setOverride(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      { tonePreset: "direct", brevityPreset: "brief" },
      null,
      CALLER_ID
    )

    expect(result.outcome).toBe("written")
    expect(revisionInsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ patch: { tonePreset: "direct", brevityPreset: "brief" } })
    )
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

  it("accepts a built-in default model even when the registry lacks it (a code default stays assignable)", async () => {
    setupTransaction()
    spyOn(AgentConfigOverrideRepository, "upsertActive").mockResolvedValue({
      outcome: "written",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })

    // Ariadne's default escalation model id (opus-4.8) is absent from
    // FAKE_MODEL_REGISTRY, but a built-in default id stays assignable to the
    // editable `model` field even when the registry lacks it (INV-16 permissive
    // for code defaults). escalationModel itself is now a locked field.
    const result = await makeService().setOverride(
      WORKSPACE_ID,
      ARIADNE_AGENT_ID,
      { model: "openrouter:anthropic/claude-opus-4.8" },
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

    const revisions = await makeService().listRevisions(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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
      patch: { tonePreset: "neutral" },
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
      CALLER
    )

    expect(result).toMatchObject({ outcome: "written", updatedAt: "2026-07-06T00:00:00.000Z" })
    // setOverride ran with the revision's patch and the caller's optimistic token.
    expect(upsert).toHaveBeenCalledWith(
      {},
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        patch: { tonePreset: "neutral" },
        expectedUpdatedAt: "2026-07-05T00:00:00.000Z",
      }
    )
    // Restore appends its own revision — history stays append-only.
    expect(revisionInsert).toHaveBeenCalledWith(
      {},
      {
        workspaceId: WORKSPACE_ID,
        agentId: ARIADNE_AGENT_ID,
        patch: { tonePreset: "neutral" },
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
      makeService().restoreRevision(WORKSPACE_ID, ARIADNE_AGENT_ID, "acrev_9", null, CALLER)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_REVISION_NOT_FOUND" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("404s a revision absent from the workspace", async () => {
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue(null)

    await expect(
      makeService().restoreRevision(WORKSPACE_ID, ARIADNE_AGENT_ID, "acrev_missing", null, CALLER)
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
      makeService().restoreRevision(WORKSPACE_ID, ARIADNE_AGENT_ID, "acrev_old", null, CALLER)
    ).rejects.toMatchObject({ status: 422, code: "PERSONA_REVISION_INCOMPATIBLE" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("422s (not a field-lock 400) restoring a legacy revision that carries a now-locked field", async () => {
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue({
      id: "acrev_rename",
      agentId: ARIADNE_AGENT_ID,
      version: 1,
      // A pre-restriction rename: `name` is a valid patch key (customs use it)
      // but is now locked for system personas.
      patch: { name: "Athena" },
      createdByKind: "user",
      createdById: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    const upsert = spyOn(AgentConfigOverrideRepository, "upsertActive")

    await expect(
      makeService().restoreRevision(WORKSPACE_ID, ARIADNE_AGENT_ID, "acrev_rename", null, CALLER)
    ).rejects.toMatchObject({ status: 422, code: "PERSONA_REVISION_INCOMPATIBLE" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("surfaces a 409 conflict from the underlying setOverride without writing a revision", async () => {
    setupTransaction()
    spyOn(PersonaConfigRevisionRepository, "findById").mockResolvedValue({
      id: "acrev_1",
      agentId: ARIADNE_AGENT_ID,
      version: 1,
      patch: { tonePreset: "warm" },
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
      CALLER
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
      patch: { tonePreset: "direct" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-04T00:00:00.000Z",
    })

    const draft = await makeService().saveDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER, { tonePreset: "direct" })

    expect(draft).toEqual({
      patch: { tonePreset: "direct" },
      testStreamId: "stream_test",
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
  })

  it("saveDraft rejects a patch touching a locked system-persona field (400) before writing", async () => {
    const upsert = spyOn(PersonaConfigDraftRepository, "upsert").mockResolvedValue({
      patch: {},
      testStreamId: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    })

    await expect(
      makeService().saveDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER, {
        description: "New tagline",
      } as PersonaConfigPatch)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_FIELD_LOCKED" })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("saveDraft rejects a model outside the registry chat set (same gate as the override)", async () => {
    const upsert = spyOn(PersonaConfigDraftRepository, "upsert").mockResolvedValue({
      patch: {},
      testStreamId: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    })

    await expect(
      makeService().saveDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER, {
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

    await service.discardDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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

    await service.discardDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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

    await service.discardDraft(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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

    const result = await service.ensureTestStream(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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

    const result = await service.ensureTestStream(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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

    const result = await service.ensureTestStream(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

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

function customPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "persona_custom_1",
    workspaceId: WORKSPACE_ID,
    slug: "helper",
    name: "Helper",
    description: "A helper",
    avatarEmoji: ":sparkles:",
    avatarUrl: null,
    systemPrompt: "Help.",
    model: "openrouter:anthropic/claude-sonnet-5",
    escalationModel: null,
    temperature: null,
    maxTokens: null,
    enabledTools: [AgentToolNames.SEND_MESSAGE],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "workspace",
    ownerUserId: null,
    status: "active",
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    ...overrides,
  }
}

describe("PersonaConfigService.forkPersona", () => {
  afterEach(() => mock.restore())

  it("materializes the source preset into the custom's free-text slots and writes a v1 revision + outbox", async () => {
    setupTransaction()
    // Source: a built-in-shaped persona carrying preset keys (no free text).
    spyOn(PersonaRepository, "findById").mockResolvedValue(
      customPersona({ managedBy: "system", tonePreset: "direct", brevityPreset: "brief", tonePrompt: null })
    )
    const inserted = customPersona({ id: "persona_custom_new", slug: "coach", name: "Coach" })
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(inserted)
    const revision = spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const persona = await makeService().forkPersona(
      WORKSPACE_ID,
      "persona_system_ariadne",
      "Coach",
      "workspace",
      CALLER
    )

    expect(persona).toMatchObject({ id: "persona_custom_new", kind: "custom" })
    const insertArg = insert.mock.calls[0]![1] as {
      slug: string
      config: { tonePrompt: string; brevityPrompt: string }
    }
    expect(insertArg.slug).toBe("coach")
    expect(insertArg.config.tonePrompt).toBe(TONE_PRESET_FRAGMENTS.direct)
    expect(insertArg.config.brevityPrompt).toBe(BREVITY_PRESET_FRAGMENTS.brief)
    expect(revision).toHaveBeenCalledTimes(1)
    expect(outbox).toHaveBeenCalledWith(
      {},
      "agent_config:updated",
      expect.objectContaining({ agentId: "persona_custom_new" })
    )
  })

  it("creates a blank agent (starter prompt, companion default model, no tools) when sourcePersonaId is null", async () => {
    setupTransaction()
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(
      customPersona({ id: "persona_custom_blank", slug: "scribe", name: "Scribe" })
    )
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const persona = await makeService().forkPersona(WORKSPACE_ID, null, "Scribe", "workspace", CALLER)

    expect(persona).toMatchObject({ id: "persona_custom_blank", kind: "custom" })
    expect(findById).not.toHaveBeenCalled()
    const insertArg = insert.mock.calls[0]![1] as { config: Record<string, unknown> }
    expect(insertArg.config).toMatchObject({
      name: "Scribe",
      systemPrompt: "You are Scribe.",
      model: COMPANION_MODEL_ID,
      enabledTools: [],
      tonePrompt: null,
      brevityPrompt: null,
      description: null,
    })
  })

  it("copies a custom source's free-text slots verbatim", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "findById").mockResolvedValue(
      customPersona({ tonePrompt: "Be blunt.", brevityPrompt: "Be terse." })
    )
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(customPersona())
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await makeService().forkPersona(WORKSPACE_ID, "persona_custom_1", "Helper 2", "workspace", CALLER)

    const insertArg = insert.mock.calls[0]![1] as { config: { tonePrompt: string; brevityPrompt: string } }
    expect(insertArg.config.tonePrompt).toBe("Be blunt.")
    expect(insertArg.config.brevityPrompt).toBe("Be terse.")
  })

  it("retries the slug with a -2 suffix on a unique-constraint collision", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "findById").mockResolvedValue(customPersona())
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("duplicate key"), { code: "23505" })
      })
      .mockImplementationOnce(async () => customPersona({ id: "persona_custom_new", slug: "helper-2" }))
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const persona = await makeService().forkPersona(WORKSPACE_ID, "persona_custom_1", "Helper", "workspace", CALLER)

    expect(persona.id).toBe("persona_custom_new")
    expect((insert.mock.calls[0]![1] as { slug: string }).slug).toBe("helper")
    expect((insert.mock.calls[1]![1] as { slug: string }).slug).toBe("helper-2")
  })

  it("404s when the source persona does not resolve", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    await expect(
      makeService().forkPersona(WORKSPACE_ID, "persona_missing", "X", "workspace", CALLER)
    ).rejects.toMatchObject({
      status: 404,
      code: "PERSONA_SOURCE_NOT_FOUND",
    })
  })

  it("400s on an empty name", async () => {
    await expect(
      makeService().forkPersona(WORKSPACE_ID, "persona_custom_1", "   ", "workspace", CALLER)
    ).rejects.toMatchObject({
      status: 400,
    })
  })
})

describe("PersonaConfigService.updateCustom", () => {
  afterEach(() => mock.restore())

  const validConfig = {
    name: "Helper",
    description: null,
    avatarEmoji: null,
    systemPrompt: "Help this workspace.",
    model: "openrouter:anthropic/claude-haiku-4.5",
    escalationModel: null,
    temperature: null,
    maxTokens: null,
    enabledTools: [AgentToolNames.SEND_MESSAGE],
    tonePrompt: "Be blunt.",
    brevityPrompt: null,
  }

  it("writes the row, appends a revision, drops the draft, and broadcasts in one txn", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const written = customPersona({ name: "Helper", updatedAt: new Date("2026-02-03T00:00:00.000Z") })
    spyOn(PersonaRepository, "updateWorkspacePersona").mockResolvedValue({
      outcome: "written",
      row: written,
      updatedAt: "2026-02-03T00:00:00.000Z",
    })
    const deleteDraft = spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    const revision = spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 2 })
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().updateCustom(
      WORKSPACE_ID,
      "persona_custom_1",
      validConfig,
      "2026-02-02T00:00:00.000Z",
      CALLER
    )

    expect(result).toMatchObject({ outcome: "written", updatedAt: "2026-02-03T00:00:00.000Z" })
    expect(deleteDraft).toHaveBeenCalled()
    expect(revision).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ agentId: "persona_custom_1", patch: validConfig, createdByKind: "user" })
    )
    expect(outbox).toHaveBeenCalledWith(
      {},
      "agent_config:updated",
      expect.objectContaining({ agentId: "persona_custom_1" })
    )
  })

  it("surfaces an optimistic-concurrency conflict with the current row's config + token", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const current = customPersona({ name: "Theirs", updatedAt: new Date("2026-02-05T00:00:00.000Z") })
    spyOn(PersonaRepository, "updateWorkspacePersona").mockResolvedValue({ outcome: "conflict", current })
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().updateCustom(
      WORKSPACE_ID,
      "persona_custom_1",
      validConfig,
      "1999-01-01T00:00:00.000Z",
      CALLER
    )

    expect(result.outcome).toBe("conflict")
    expect(result).toMatchObject({
      current: { updatedAt: "2026-02-05T00:00:00.000Z", config: { name: "Theirs", managedBy: "workspace" } },
    })
    expect(outbox).not.toHaveBeenCalled()
  })

  it("400s (PERSONA_NOT_CUSTOM) for a built-in id — the locked built-in path is untouched", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    await expect(
      makeService().updateCustom(WORKSPACE_ID, ARIADNE_AGENT_ID, validConfig, null, CALLER)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_CUSTOM" })
  })

  it("400s on an unassignable model (the row's current values stay legal)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    await expect(
      makeService().updateCustom(
        WORKSPACE_ID,
        "persona_custom_1",
        { ...validConfig, model: "openrouter:openai/text-embedding-3-small" },
        null,
        CALLER
      )
    ).rejects.toMatchObject({ status: 400, code: "UNSUPPORTED_PERSONA_MODEL" })
  })
})

describe("PersonaConfigService custom getConfig + status", () => {
  afterEach(() => mock.restore())

  it("getConfig returns the custom shape (kind custom, defaults null, row as resolved, row updatedAt as token)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, "persona_custom_1", CALLER)

    expect(config).toMatchObject({
      kind: "custom",
      defaults: null,
      overridePatch: null,
      overrideUpdatedAt: "2026-02-02T00:00:00.000Z",
      resolved: { id: "persona_custom_1", managedBy: "workspace", tonePreset: null },
    })
  })

  it("setCustomStatus flips status and broadcasts for a custom", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaRepository, "setStatus").mockResolvedValue(customPersona({ status: "archived" }))
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const persona = await makeService().setCustomStatus(WORKSPACE_ID, "persona_custom_1", "archived", CALLER)

    expect(persona).toMatchObject({ id: "persona_custom_1", kind: "custom" })
    expect(outbox).toHaveBeenCalledWith(
      {},
      "agent_config:updated",
      expect.objectContaining({ agentId: "persona_custom_1" })
    )
  })

  it("setCustomStatus 400s (PERSONA_NOT_CUSTOM) for a built-in", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    await expect(
      makeService().setCustomStatus(WORKSPACE_ID, ARIADNE_AGENT_ID, "archived", CALLER)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_CUSTOM" })
  })

  it("setCustomAvatar writes the pointer, broadcasts, and returns the prior avatar for cleanup", async () => {
    setupTransaction()
    const previous = "avatars/workspace_1/personas/persona_custom_1/111"
    const next = "avatars/workspace_1/personas/persona_custom_1/222"
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "custom",
      row: customPersona({ avatarUrl: previous }),
    })
    const update = spyOn(PersonaRepository, "updateAvatarUrl").mockResolvedValue(customPersona({ avatarUrl: next }))
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().setCustomAvatar(WORKSPACE_ID, "persona_custom_1", next, CALLER)

    expect(result).toEqual({
      persona: expect.objectContaining({ id: "persona_custom_1", kind: "custom", avatarUrl: next }),
      previousAvatarUrl: previous,
      updatedAt: expect.any(String),
    })
    expect(update).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, personaId: "persona_custom_1", avatarUrl: next, viewer: { userId: CALLER_ID } }
    )
    expect(outbox).toHaveBeenCalledWith(
      {},
      "agent_config:updated",
      expect.objectContaining({ agentId: "persona_custom_1" })
    )
  })

  it("setCustomAvatar 400s (PERSONA_NOT_CUSTOM) for a built-in", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    await expect(
      makeService().setCustomAvatar(WORKSPACE_ID, ARIADNE_AGENT_ID, "avatars/x", CALLER)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_CUSTOM" })
  })

  it("setCustomAvatar short-circuits a clear when the persona has no avatar (no write/broadcast)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "custom",
      row: customPersona({ avatarUrl: null }),
    })
    const update = spyOn(PersonaRepository, "updateAvatarUrl").mockResolvedValue(customPersona())
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().setCustomAvatar(WORKSPACE_ID, "persona_custom_1", null, CALLER)

    expect(result.previousAvatarUrl).toBeNull()
    expect(update).not.toHaveBeenCalled()
    expect(outbox).not.toHaveBeenCalled()
  })
})

// ── user-scoped personas ─────────────────────────────────────────────────────

const MEMBER: PersonaCaller = { userId: "usr_member", isAdmin: false }
const OWNER: PersonaCaller = { userId: "usr_owner", isAdmin: false }

function personalPersona(overrides: Partial<Persona> = {}): Persona {
  return customPersona({
    id: "persona_personal_1",
    slug: "my-helper",
    name: "My Helper",
    managedBy: "user",
    ownerUserId: OWNER.userId,
    ...overrides,
  })
}

describe("PersonaConfigService.forkPersona — scope (user-scoped-personas)", () => {
  afterEach(() => mock.restore())

  it("rejects a non-admin workspace fork with 403 before writing", async () => {
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona")
    await expect(makeService().forkPersona(WORKSPACE_ID, null, "Helper", "workspace", MEMBER)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("lets any member fork a personal persona: managed_by='user', owner=caller, broadcast carries ownerUserId", async () => {
    setupTransaction()
    // Source: a workspace custom the member can resolve.
    spyOn(PersonaRepository, "findById").mockResolvedValue(customPersona())
    const inserted = personalPersona({ id: "persona_personal_new", slug: "helper", ownerUserId: MEMBER.userId })
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(inserted)
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const persona = await makeService().forkPersona(WORKSPACE_ID, "persona_custom_1", "Helper", "personal", MEMBER)

    expect(persona).toMatchObject({ id: "persona_personal_new", kind: "personal", ownerUserId: MEMBER.userId })
    expect((insert.mock.calls[0]![1] as { ownerUserId?: string }).ownerUserId).toBe(MEMBER.userId)
    // The broadcast payload carries ownerUserId → delivery-groups routes it to the owner only.
    expect(outbox).toHaveBeenCalledWith(
      {},
      "agent_config:updated",
      expect.objectContaining({ persona: expect.objectContaining({ ownerUserId: MEMBER.userId, kind: "personal" }) })
    )
  })

  it("blank personal fork stamps the owner without a source lookup", async () => {
    setupTransaction()
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(
      personalPersona({ id: "persona_personal_blank", slug: "scribe", ownerUserId: MEMBER.userId })
    )
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await makeService().forkPersona(WORKSPACE_ID, null, "Scribe", "personal", MEMBER)

    expect(findById).not.toHaveBeenCalled()
    expect((insert.mock.calls[0]![1] as { ownerUserId?: string }).ownerUserId).toBe(MEMBER.userId)
  })

  it("404s when the source is another user's personal persona (invisible → not forkable)", async () => {
    // findById is workspace-scoped and returns the row; the service filters it
    // out because its owner is not the caller.
    spyOn(PersonaRepository, "findById").mockResolvedValue(personalPersona({ ownerUserId: "usr_other" }))
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona")
    await expect(
      makeService().forkPersona(WORKSPACE_ID, "persona_personal_1", "Steal", "personal", MEMBER)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_SOURCE_NOT_FOUND" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("lets a member fork their OWN personal persona as a source", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "findById").mockResolvedValue(personalPersona({ ownerUserId: OWNER.userId }))
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(
      personalPersona({ id: "persona_personal_copy", slug: "my-helper-2" })
    )
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await makeService().forkPersona(WORKSPACE_ID, "persona_personal_1", "My Helper 2", "personal", OWNER)

    expect(insert).toHaveBeenCalledTimes(1)
  })
})

describe("PersonaConfigService lifecycle authorization (user-scoped-personas)", () => {
  afterEach(() => mock.restore())

  const validConfig = {
    name: "Helper",
    description: null,
    avatarEmoji: null,
    systemPrompt: "Help this workspace.",
    model: "openrouter:anthropic/claude-haiku-4.5",
    escalationModel: null,
    temperature: null,
    maxTokens: null,
    enabledTools: [AgentToolNames.SEND_MESSAGE],
    tonePrompt: null,
    brevityPrompt: null,
  }

  it("member acting on a workspace custom gets 403 (equivalent to the old admin gate)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    await expect(
      makeService().updateCustom(WORKSPACE_ID, "persona_custom_1", validConfig, null, MEMBER)
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" })
  })

  it("member acting on a built-in gets 403", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    await expect(makeService().listRevisions(WORKSPACE_ID, ARIADNE_AGENT_ID, MEMBER)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
  })

  it("a non-owner (or admin) acting on someone else's personal persona gets 404, never 403", async () => {
    // Viewer-scoped resolveEditable returns null for a persona the caller can't
    // see — invisible means invisible.
    const resolve = spyOn(PersonaRepository, "resolveEditable").mockResolvedValue(null)
    const admin: PersonaCaller = { userId: "usr_admin", isAdmin: true }
    await expect(
      makeService().updateCustom(WORKSPACE_ID, "persona_personal_1", validConfig, null, admin)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
    // resolveEditable was called with the caller as the viewer (not undefined).
    expect(resolve.mock.calls[0]![3]).toEqual({ userId: "usr_admin" })
  })

  it("owner updates their personal persona: passes the viewer to the write and broadcasts kind:personal", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: personalPersona() })
    const update = spyOn(PersonaRepository, "updateWorkspacePersona").mockResolvedValue({
      outcome: "written",
      row: personalPersona({ name: "Helper" }),
      updatedAt: "2026-02-03T00:00:00.000Z",
    })
    spyOn(PersonaConfigDraftRepository, "deleteByOwner").mockResolvedValue(null)
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 2 })
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await makeService().updateCustom(WORKSPACE_ID, "persona_personal_1", validConfig, null, OWNER)

    expect(result).toMatchObject({ outcome: "written" })
    expect(update.mock.calls[0]![1]).toMatchObject({ viewer: { userId: OWNER.userId } })
    expect(outbox).toHaveBeenCalledWith(
      {},
      "agent_config:updated",
      expect.objectContaining({ persona: expect.objectContaining({ kind: "personal", ownerUserId: OWNER.userId }) })
    )
  })

  it("owner archives their personal persona (setStatus gets the viewer)", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: personalPersona() })
    const setStatus = spyOn(PersonaRepository, "setStatus").mockResolvedValue(personalPersona({ status: "archived" }))
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const persona = await makeService().setCustomStatus(WORKSPACE_ID, "persona_personal_1", "archived", OWNER)

    expect(persona).toMatchObject({ kind: "personal", status: "archived" })
    expect(setStatus.mock.calls[0]![1]).toMatchObject({ viewer: { userId: OWNER.userId } })
  })

  it("member archiving a workspace custom gets 403", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    await expect(
      makeService().setCustomStatus(WORKSPACE_ID, "persona_custom_1", "archived", MEMBER)
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" })
  })

  it("owner sets their personal persona avatar (updateAvatarUrl gets the viewer)", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: personalPersona() })
    const update = spyOn(PersonaRepository, "updateAvatarUrl").mockResolvedValue(
      personalPersona({ avatarUrl: "avatars/x/222" })
    )
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await makeService().setCustomAvatar(WORKSPACE_ID, "persona_personal_1", "avatars/x/222", OWNER)

    expect(update.mock.calls[0]![1]).toMatchObject({ viewer: { userId: OWNER.userId } })
  })

  it("getConfig for a personal persona returns kind:'personal' and managedBy:'user' for its owner", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: personalPersona() })
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)

    const config = await makeService().getConfig(WORKSPACE_ID, "persona_personal_1", OWNER)

    expect(config).toMatchObject({ kind: "personal", resolved: { managedBy: "user" } })
  })

  it("member getConfig on a workspace custom gets 403", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    await expect(makeService().getConfig(WORKSPACE_ID, "persona_custom_1", MEMBER)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
  })

  it("owner saves a draft on their personal persona; a member on a workspace custom gets 403", async () => {
    const owns = spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "custom",
      row: personalPersona(),
    })
    spyOn(PersonaConfigDraftRepository, "upsert").mockResolvedValue({
      patch: {},
      testStreamId: null,
      updatedAt: "2026-07-04T00:00:00.000Z",
    })
    await makeService().saveDraft(WORKSPACE_ID, "persona_personal_1", OWNER, {})

    owns.mockResolvedValue({ kind: "custom", row: customPersona() })
    await expect(makeService().saveDraft(WORKSPACE_ID, "persona_custom_1", MEMBER, {})).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
  })

  it("discardDraft authorizes the persona: a member on a workspace custom gets 403", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const findByOwner = spyOn(PersonaConfigDraftRepository, "findByOwner")
    await expect(makeService().discardDraft(WORKSPACE_ID, "persona_custom_1", MEMBER)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
    expect(findByOwner).not.toHaveBeenCalled()
  })
})

describe("PersonaConfigService.listArchived — caller-aware (user-scoped-personas)", () => {
  afterEach(() => mock.restore())

  it("admin gets workspace-archived ∪ own archived personal (includeWorkspace true + ownerUserId)", async () => {
    const list = spyOn(PersonaRepository, "listArchivedCustoms").mockResolvedValue([])
    await makeService().listArchived(WORKSPACE_ID, CALLER)
    expect(list.mock.calls[0]![2]).toEqual({ includeWorkspace: true, ownerUserId: CALLER.userId })
  })

  it("non-admin gets only their own archived personal (includeWorkspace false)", async () => {
    const list = spyOn(PersonaRepository, "listArchivedCustoms").mockResolvedValue([
      personalPersona({ status: "archived", ownerUserId: MEMBER.userId }),
    ])
    const personas = await makeService().listArchived(WORKSPACE_ID, MEMBER)
    expect(list.mock.calls[0]![2]).toEqual({ includeWorkspace: false, ownerUserId: MEMBER.userId })
    expect(personas[0]).toMatchObject({ kind: "personal", ownerUserId: MEMBER.userId })
  })
})
