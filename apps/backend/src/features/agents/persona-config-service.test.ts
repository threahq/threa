import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import type { ModelCapabilities, ModelRegistry } from "@threa/agent-runtime"
import {
  AgentToolNames,
  CompanionModes,
  MemoryModes,
  PERSONA_ATTACHMENT_MAX_COUNT,
  StreamPurposes,
  type PersonaConfigPatch,
} from "@threa/types"
import { PersonaConfigService, type PersonaCaller } from "./persona-config-service"
import { AgentConfigOverrideRepository } from "./agent-config-override-repository"
import { PersonaConfigDraftRepository } from "./persona-config-draft-repository"
import { PersonaConfigRevisionRepository } from "./persona-config-revision-repository"
import { PersonaRepository, type Persona } from "./persona-repository"
import { PersonaAttachmentRepository } from "./persona-attachment-repository"
import { PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS } from "./config"
import { COMPANION_MODEL_ID, TONE_PRESET_FRAGMENTS, BREVITY_PRESET_FRAGMENTS } from "./companion/config"
import { OutboxRepository } from "../../lib/outbox"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID, getVisibleBuiltInAgentConfig } from "./built-in-agents"
import { AttachmentReferenceRepository } from "../attachments"
import { SharedMessageRepository } from "../messaging"
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

function makeService(
  streamService: any = { getStreamById: mock(async (id: string) => ({ id, archivedAt: null })) },
  extra: { attachmentService?: any } = {}
) {
  return new PersonaConfigService({
    pool: {} as any,
    streamService,
    modelRegistry: FAKE_MODEL_REGISTRY,
    attachmentService: extra.attachmentService ?? ({} as any),
  })
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
      attachmentService: {} as any,
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
      attachmentService: {} as any,
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
      attachmentService: {} as any,
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
      attachmentService: {} as any,
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
      attachmentService: {} as any,
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
      attachmentService: {} as any,
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
      attachmentService: {} as any,
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
    spyOn(PersonaAttachmentRepository, "listForPersona").mockResolvedValue([])

    const config = await makeService().getConfig(WORKSPACE_ID, "persona_custom_1", CALLER)

    expect(config).toMatchObject({
      kind: "custom",
      defaults: null,
      overridePatch: null,
      overrideUpdatedAt: "2026-02-02T00:00:00.000Z",
      resolved: { id: "persona_custom_1", managedBy: "workspace", tonePreset: null },
      attachments: [],
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

  // Per-owner slug namespace (user-scoped-personas AMENDED). The retry loop is
  // unchanged — both partial unique indexes surface 23505 — but a personal fork's
  // base slug is available in each owner's own namespace, so two members forking
  // the same name both land the clean slug without a cross-user suffix. The DB
  // migration test proves the index; these prove the service's slug plumbing.
  it("personal fork of 'Coach' lands the clean slug 'coach' for each owner independently", async () => {
    for (const member of [MEMBER, OWNER]) {
      mock.restore()
      setupTransaction()
      spyOn(PersonaRepository, "findById").mockResolvedValue(null)
      const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(
        personalPersona({ id: "persona_personal_coach", slug: "coach", ownerUserId: member.userId })
      )
      spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
      spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

      await makeService().forkPersona(WORKSPACE_ID, null, "Coach", "personal", member)

      expect(insert).toHaveBeenCalledTimes(1)
      expect((insert.mock.calls[0]![1] as { slug: string; ownerUserId?: string }).slug).toBe("coach")
      expect((insert.mock.calls[0]![1] as { ownerUserId?: string }).ownerUserId).toBe(member.userId)
    }
  })

  it("workspace fork of 'Coach' lands the clean shared slug 'coach' (shared namespace unaffected by personal rows)", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona").mockResolvedValue(
      customPersona({ id: "persona_ws_coach", slug: "coach" })
    )
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await makeService().forkPersona(WORKSPACE_ID, null, "Coach", "workspace", CALLER)

    expect(insert).toHaveBeenCalledTimes(1)
    expect((insert.mock.calls[0]![1] as { slug: string; ownerUserId?: string }).slug).toBe("coach")
    expect((insert.mock.calls[0]![1] as { ownerUserId?: string }).ownerUserId).toBeUndefined()
  })

  it("same owner forking 'Coach' twice suffixes to 'coach-2' on the 23505 (own-namespace collision)", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    const insert = spyOn(PersonaRepository, "insertWorkspacePersona")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("duplicate key"), { code: "23505" })
      })
      .mockImplementationOnce(async () =>
        personalPersona({ id: "persona_personal_coach2", slug: "coach-2", ownerUserId: OWNER.userId })
      )
    spyOn(PersonaConfigRevisionRepository, "insert").mockResolvedValue({ version: 1 })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const persona = await makeService().forkPersona(WORKSPACE_ID, null, "Coach", "personal", OWNER)

    expect(persona.slug).toBe("coach-2")
    expect((insert.mock.calls[0]![1] as { slug: string }).slug).toBe("coach")
    expect((insert.mock.calls[1]![1] as { slug: string }).slug).toBe("coach-2")
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
    spyOn(PersonaAttachmentRepository, "listForPersona").mockResolvedValue([])

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

// ── persona context attachments (persona-context-attachments) ─────────────────

const ADMIN: PersonaCaller = { userId: "usr_admin", isAdmin: true }

const ATTACHMENT_ID = "attach_knowledge_1"

/** A settled, scanned-clean, caller-owned, message-unbound workspace upload — the bindable happy state. */
function settledAttachment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ATTACHMENT_ID,
    workspaceId: WORKSPACE_ID,
    uploadedBy: ADMIN.userId,
    streamId: null,
    messageId: null,
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 18,
    safetyStatus: "clean",
    ...overrides,
  }
}

/**
 * Attachment-service seam for the bind path: `getById` returns the row to bind,
 * `getSharingBlockReason` is the settled-and-safe predicate (null = safe), and
 * `deleteIfUnbound` is the race-safe cap-race / remove cleanup (`{ deleted }`;
 * `false` = a message claimed the file, so its bytes were left intact — INV-20).
 * No S3 / createForUpload — the bytes already landed through the shared upload
 * transport (INV-35/37).
 */
function makeBindDeps(overrides: { getById?: any; getSharingBlockReason?: any; deleteIfUnbound?: any } = {}): {
  attachmentService: any
} {
  const attachmentService = {
    getById: overrides.getById ?? mock(async () => settledAttachment()),
    getSharingBlockReason: overrides.getSharingBlockReason ?? mock(() => null),
    deleteIfUnbound: overrides.deleteIfUnbound ?? mock(async () => ({ deleted: true })),
  }
  return { attachmentService }
}

function binding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    attachmentId: ATTACHMENT_ID,
    workspaceId: WORKSPACE_ID,
    personaId: "persona_custom_1",
    position: 0,
    createdBy: ADMIN.userId,
    createdAt: new Date("2026-07-13T00:00:00Z"),
    ...overrides,
  } as any
}

describe("PersonaConfigService.bindAttachment — authorization matrix", () => {
  afterEach(() => mock.restore())

  it("workspace persona: an admin may bind an own settled upload", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const insert = spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(binding())
    const deps = makeBindDeps()

    const item = await makeService(undefined, deps).bindAttachment(
      WORKSPACE_ID,
      "persona_custom_1",
      ADMIN,
      ATTACHMENT_ID
    )

    expect(item).toMatchObject({
      id: ATTACHMENT_ID,
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 18,
      processingStatus: "processing",
      contextMode: null,
      position: 0,
    })
    expect(insert.mock.calls[0]![1]).toMatchObject({
      attachmentId: ATTACHMENT_ID,
      workspaceId: WORKSPACE_ID,
      personaId: "persona_custom_1",
      maxCount: PERSONA_ATTACHMENT_MAX_COUNT,
    })
  })

  it("workspace persona: a non-admin member is 403'd", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const insert = spyOn(PersonaAttachmentRepository, "insertBinding")
    const deps = makeBindDeps()

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", MEMBER, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("personal persona: the owner may bind", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: personalPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(
      binding({ personaId: "persona_personal_1", createdBy: OWNER.userId })
    )
    const deps = makeBindDeps({ getById: mock(async () => settledAttachment({ uploadedBy: OWNER.userId })) })

    const item = await makeService(undefined, deps).bindAttachment(
      WORKSPACE_ID,
      "persona_personal_1",
      OWNER,
      ATTACHMENT_ID
    )
    expect(item.id).toBe(ATTACHMENT_ID)
    expect(item.position).toBe(0)
  })

  it("personal persona: a non-owner member 404s (resolveEditable filters it — invisible)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue(null)
    const insert = spyOn(PersonaAttachmentRepository, "insertBinding")
    const deps = makeBindDeps()

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_personal_1", MEMBER, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("personal persona: a non-owner ADMIN also 404s (invisible means invisible)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue(null)
    const deps = makeBindDeps()

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_personal_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
  })

  it("a built-in persona 400s PERSONA_NOT_CUSTOM (no owned row to bind to)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    const insert = spyOn(PersonaAttachmentRepository, "insertBinding")
    const deps = makeBindDeps()

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, ARIADNE_AGENT_ID, ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_CUSTOM" })
    expect(insert).not.toHaveBeenCalled()
  })
})

describe("PersonaConfigService.bindAttachment — attachment state gates", () => {
  afterEach(() => mock.restore())

  it("404s a missing attachment", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const insert = spyOn(PersonaAttachmentRepository, "insertBinding")
    const deps = makeBindDeps({ getById: mock(async () => null) })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_NOT_FOUND" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("404s a cross-workspace attachment (never bind another workspace's upload)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const deps = makeBindDeps({ getById: mock(async () => settledAttachment({ workspaceId: "workspace_other" })) })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_NOT_FOUND" })
  })

  it("404s an attachment uploaded by another user (does not leak an unbound upload)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const deps = makeBindDeps({ getById: mock(async () => settledAttachment({ uploadedBy: "usr_someone_else" })) })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_NOT_FOUND" })
  })

  it("400s an attachment already bound to a message", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const deps = makeBindDeps({
      getById: mock(async () => settledAttachment({ streamId: "stream_1", messageId: "msg_1" })),
    })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_BOUND" })
  })

  it("400s a not-yet-settled (pending_upload) attachment — a client cannot bind mid-upload", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const deps = makeBindDeps({
      getById: mock(async () => settledAttachment({ safetyStatus: "pending_upload" })),
      getSharingBlockReason: mock(() => "Attachment upload has not completed"),
    })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_NOT_SETTLED" })
  })

  it("400s a disallowed mime type with a structured error naming the allowed set", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const deps = makeBindDeps({
      getById: mock(async () => settledAttachment({ mimeType: "image/png", filename: "logo.png" })),
    })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_INVALID_TYPE" })
  })

  it("400s an oversized attachment (persona rules apply at bind, not at reserve)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const deps = makeBindDeps({
      getById: mock(async () => settledAttachment({ sizeBytes: 21 * 1024 * 1024 })),
    })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_TOO_LARGE" })
  })
})

describe("PersonaConfigService.bindAttachment — cap and conflicts", () => {
  afterEach(() => mock.restore())

  it("409s when the attachment is already bound to a persona (unique PK) and never deletes it", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockRejectedValue({ code: "23505" })
    const del = mock(async () => ({ deleted: true }))
    const deps = makeBindDeps({ deleteIfUnbound: del })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 409, code: "PERSONA_ATTACHMENT_ALREADY_BOUND" })
    // The attachment belongs to the existing binding — must NOT be deleted.
    expect(del).not.toHaveBeenCalled()
  })

  it("lost cap race (insertBinding null) hard-deletes the settled-but-unbound attachment and 400s", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(null)
    const del = mock(async () => ({ deleted: true }))
    const deps = makeBindDeps({ deleteIfUnbound: del })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_LIMIT" })
    // The sweep never reaps a settled-but-unbound attachment (its tracking row is
    // gone), so bind must delete it to avoid a permanent orphan — race-safely, so
    // a file a message claimed in the meantime keeps its bytes (INV-20).
    expect(del).toHaveBeenCalledWith(ATTACHMENT_ID)
  })

  it("lost cap race where a message claimed the file: cleanup no-ops but still 400s", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(null)
    const del = mock(async () => ({ deleted: false }))
    const deps = makeBindDeps({ deleteIfUnbound: del })

    await expect(
      makeService(undefined, deps).bindAttachment(WORKSPACE_ID, "persona_custom_1", ADMIN, ATTACHMENT_ID)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_LIMIT" })
    expect(del).toHaveBeenCalledWith(ATTACHMENT_ID)
  })
})

// A CLEAN, message-bound source the caller can read — the normal copy-on-attach case.
function sourceAttachment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "attach_source_1",
    workspaceId: WORKSPACE_ID,
    uploadedBy: ADMIN.userId,
    streamId: "stream_src",
    messageId: "msg_src",
    filename: "runbook.md",
    mimeType: "text/markdown",
    sizeBytes: 512,
    storagePath: `${WORKSPACE_ID}/attach_source_1/runbook.md`,
    processingStatus: "completed",
    safetyStatus: "clean",
    e2eOnly: false,
    thumbnailStoragePath: null,
    width: null,
    height: null,
    ...overrides,
  }
}

/** A persona knowledge list row for the post-bind re-read (contextMode derivation). */
function personaListRow(attachmentId: string, opts: { hasExtraction: boolean; processingStatus?: string }) {
  return {
    attachmentId,
    filename: "runbook.md",
    mimeType: "text/markdown",
    sizeBytes: 512,
    position: 0,
    createdAt: new Date("2026-07-13T00:00:00Z"),
    processingStatus: (opts.processingStatus ?? "completed") as any,
    hasExtraction: opts.hasExtraction,
    fullTextChars: opts.hasExtraction ? 40 : null,
    summaryChars: opts.hasExtraction ? 20 : null,
  }
}

/**
 * Attachment-service seam for the copy-on-attach path: `getById` returns the
 * SOURCE, `copyForPersona` records the generated new id and returns the copy row,
 * `deleteIfUnbound` is the cap-loss / error cleanup. A `streamService` with
 * `tryAccess` grants source readability for the bound-source cases.
 */
function makeAttachDeps(
  overrides: {
    getById?: any
    copyForPersona?: any
    deleteIfUnbound?: any
  } = {}
): { attachmentService: any; capturedNewId: () => string } {
  let captured = ""
  const copyForPersona =
    overrides.copyForPersona ??
    mock(async (p: any) => {
      captured = p.newId
      return { ...sourceAttachment(), id: p.newId }
    })
  const attachmentService = {
    getById: overrides.getById ?? mock(async () => sourceAttachment()),
    copyForPersona,
    deleteIfUnbound: overrides.deleteIfUnbound ?? mock(async () => ({ deleted: true })),
  }
  return { attachmentService, capturedNewId: () => captured }
}

function grantingStreamService() {
  return { tryAccess: mock(async () => ({ id: "stream_src", archivedAt: null })) }
}

describe("PersonaConfigService.attachFromExisting — authorization matrix", () => {
  afterEach(() => mock.restore())

  it("workspace persona: an admin may copy a readable source; returns a ready item with a real contextMode", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(binding())
    const { attachmentService, capturedNewId } = makeAttachDeps()
    spyOn(PersonaAttachmentRepository, "listForPersona").mockImplementation(async () => [
      personaListRow(capturedNewId(), { hasExtraction: true }),
    ])

    const item = await makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
      WORKSPACE_ID,
      "persona_custom_1",
      ADMIN,
      "attach_source_1"
    )

    expect(item).toMatchObject({
      filename: "runbook.md",
      mimeType: "text/markdown",
      processingStatus: "ready",
      contextMode: "full",
    })
    expect(attachmentService.copyForPersona).toHaveBeenCalledTimes(1)
    expect(attachmentService.copyForPersona.mock.calls[0]![0]).toMatchObject({ uploadedBy: ADMIN.userId })
  })

  it("workspace persona: a non-admin member is 403'd and no copy is performed", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps()

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        MEMBER,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
    expect(attachmentService.getById).not.toHaveBeenCalled()
  })

  it("personal persona: the owner may copy", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: personalPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(
      binding({ personaId: "persona_personal_1", createdBy: OWNER.userId })
    )
    const { attachmentService, capturedNewId } = makeAttachDeps({
      getById: mock(async () => sourceAttachment({ uploadedBy: OWNER.userId, streamId: null, messageId: null })),
    })
    spyOn(PersonaAttachmentRepository, "listForPersona").mockImplementation(async () => [
      personaListRow(capturedNewId(), { hasExtraction: true }),
    ])

    const item = await makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
      WORKSPACE_ID,
      "persona_personal_1",
      OWNER,
      "attach_source_1"
    )
    expect(item.processingStatus).toBe("ready")
  })

  it("personal persona: a non-owner (admin included) 404s (invisible means invisible)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue(null)
    const { attachmentService } = makeAttachDeps()

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_personal_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
  })

  it("a built-in persona 400s PERSONA_NOT_CUSTOM", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    const { attachmentService } = makeAttachDeps()

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        ARIADNE_AGENT_ID,
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_CUSTOM" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
  })
})

describe("PersonaConfigService.attachFromExisting — source gates", () => {
  afterEach(() => mock.restore())

  it("404s a missing source and never copies", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps({ getById: mock(async () => null) })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_SOURCE_NOT_FOUND" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
  })

  it("404s a cross-workspace source", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps({
      getById: mock(async () => sourceAttachment({ workspaceId: "workspace_other" })),
    })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_SOURCE_NOT_FOUND" })
  })

  it("404s when the caller cannot read the source stream and performs NO copy", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    // Bound source, but tryAccess denies and the share/reference fallback also denies.
    spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
    spyOn(AttachmentReferenceRepository, "hasViewerAccessByReference").mockResolvedValue(false)
    const streamService = { tryAccess: mock(async () => null) }
    const { attachmentService } = makeAttachDeps()

    await expect(
      makeService(streamService, { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_SOURCE_NOT_FOUND" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
  })

  it("404s an UNBOUND source uploaded by someone else (uploader-only), no copy", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps({
      getById: mock(async () => sourceAttachment({ streamId: null, messageId: null, uploadedBy: "usr_someone_else" })),
    })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_SOURCE_NOT_FOUND" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
  })

  it("400s a non-CLEAN source (e2e_unscanned / pending scan / quarantined)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps({
      getById: mock(async () => sourceAttachment({ safetyStatus: "e2e_unscanned" })),
    })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_SOURCE_NOT_CLEAN" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
  })

  it("400s an e2e_only source even if flagged clean", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps({
      getById: mock(async () => sourceAttachment({ e2eOnly: true })),
    })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_SOURCE_NOT_CLEAN" })
  })

  it("400s a disallowed mime type", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps({
      getById: mock(async () => sourceAttachment({ mimeType: "image/png", filename: "logo.png" })),
    })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_INVALID_TYPE" })
    expect(attachmentService.copyForPersona).not.toHaveBeenCalled()
  })

  it("400s an oversized source", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const { attachmentService } = makeAttachDeps({
      getById: mock(async () => sourceAttachment({ sizeBytes: 21 * 1024 * 1024 })),
    })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_TOO_LARGE" })
  })
})

describe("PersonaConfigService.attachFromExisting — copy, cap, and cleanup", () => {
  afterEach(() => mock.restore())

  it("a copy that kicked the pipeline (no extraction) is `processing` with a null contextMode", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(binding())
    const { attachmentService, capturedNewId } = makeAttachDeps()
    spyOn(PersonaAttachmentRepository, "listForPersona").mockImplementation(async () => [
      personaListRow(capturedNewId(), { hasExtraction: false, processingStatus: "pending" }),
    ])

    const item = await makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
      WORKSPACE_ID,
      "persona_custom_1",
      ADMIN,
      "attach_source_1"
    )
    expect(item.processingStatus).toBe("processing")
    expect(item.contextMode).toBeNull()
  })

  it("lost cap race (insertBinding null) hard-deletes the just-created copy and 400s", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "insertBinding").mockResolvedValue(null)
    const del = mock(async () => ({ deleted: true }))
    const { attachmentService, capturedNewId } = makeAttachDeps({ deleteIfUnbound: del })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_ATTACHMENT_LIMIT" })
    // The copy is the freshly-generated id, not the source — cleanup targets it.
    expect(del).toHaveBeenCalledWith(capturedNewId())
    expect(capturedNewId()).not.toBe("attach_source_1")
  })

  it("propagates a copy failure without binding (the copy's own S3 cleanup runs in the attachment layer)", async () => {
    setupTransaction()
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const insert = spyOn(PersonaAttachmentRepository, "insertBinding")
    const { attachmentService } = makeAttachDeps({
      copyForPersona: mock(async () => {
        throw new Error("s3 copy boom")
      }),
    })

    await expect(
      makeService(grantingStreamService(), { attachmentService }).attachFromExisting(
        WORKSPACE_ID,
        "persona_custom_1",
        ADMIN,
        "attach_source_1"
      )
    ).rejects.toThrow("s3 copy boom")
    expect(insert).not.toHaveBeenCalled()
  })
})

describe("PersonaConfigService.removeAttachment", () => {
  afterEach(() => mock.restore())

  it("deletes the binding then hard-deletes the attachment row + S3 object (only while unbound)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "deleteBinding").mockResolvedValue(true)
    const del = mock(async () => ({ deleted: true }))
    const deps = makeBindDeps({ deleteIfUnbound: del })

    await makeService(undefined, deps).removeAttachment(WORKSPACE_ID, "persona_custom_1", "att_1", ADMIN)

    expect(del).toHaveBeenCalledWith("att_1")
  })

  it("still succeeds when a message claimed the file first (binding gone, bytes left intact)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    const unbind = spyOn(PersonaAttachmentRepository, "deleteBinding").mockResolvedValue(true)
    const del = mock(async () => ({ deleted: false }))
    const deps = makeBindDeps({ deleteIfUnbound: del })

    // No throw: the user-visible action (unbind) happened; the file's bytes are a
    // message's now and were intentionally not destroyed.
    await makeService(undefined, deps).removeAttachment(WORKSPACE_ID, "persona_custom_1", "att_1", ADMIN)

    expect(unbind).toHaveBeenCalled()
    expect(del).toHaveBeenCalledWith("att_1")
  })

  it("404s when the binding does not exist (and never touches the attachment)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaAttachmentRepository, "deleteBinding").mockResolvedValue(false)
    const del = mock(async () => ({ deleted: true }))
    const deps = makeBindDeps({ deleteIfUnbound: del })

    await expect(
      makeService(undefined, deps).removeAttachment(WORKSPACE_ID, "persona_custom_1", "missing", ADMIN)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_ATTACHMENT_NOT_FOUND" })
    expect(del).not.toHaveBeenCalled()
  })

  it("a non-owner ADMIN 404s on a personal persona's attachment (invisible)", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue(null)
    const deps = makeBindDeps()

    await expect(
      makeService(undefined, deps).removeAttachment(WORKSPACE_ID, "persona_personal_1", "att_1", ADMIN)
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
  })

  it("400s PERSONA_NOT_CUSTOM for a built-in", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    const deps = makeBindDeps()

    await expect(
      makeService(undefined, deps).removeAttachment(WORKSPACE_ID, ARIADNE_AGENT_ID, "att_1", ADMIN)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_CUSTOM" })
  })
})

describe("PersonaConfigService.getConfig — attachments fold-in", () => {
  afterEach(() => mock.restore())

  it("maps extraction/pipeline state to structured processing status + context mode, in position order", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({ kind: "custom", row: customPersona() })
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)
    spyOn(PersonaAttachmentRepository, "listForPersona").mockResolvedValue([
      {
        // Ready, short full text within the inline cap → referenced in full.
        attachmentId: "att_full",
        filename: "ready.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        position: 0,
        createdAt: new Date("2026-07-13T00:00:00Z"),
        processingStatus: "completed",
        hasExtraction: true,
        fullTextChars: 1200,
        summaryChars: 80,
      },
      {
        // Ready, full text over the inline cap but a summary present → summary only.
        attachmentId: "att_summary",
        filename: "huge.txt",
        mimeType: "text/plain",
        sizeBytes: 999999,
        position: 1,
        createdAt: new Date("2026-07-13T00:00:30Z"),
        processingStatus: "completed",
        hasExtraction: true,
        fullTextChars: PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS + 1,
        summaryChars: 120,
      },
      {
        // Ready but the extraction produced neither text nor summary → name only.
        attachmentId: "att_name",
        filename: "empty.txt",
        mimeType: "text/plain",
        sizeBytes: 0,
        position: 2,
        createdAt: new Date("2026-07-13T00:00:45Z"),
        processingStatus: "completed",
        hasExtraction: true,
        fullTextChars: 0,
        summaryChars: null,
      },
      {
        // Extraction still in flight → status processing, mode null (no content yet).
        attachmentId: "att_processing",
        filename: "wip.pdf",
        mimeType: "application/pdf",
        sizeBytes: 20,
        position: 3,
        createdAt: new Date("2026-07-13T00:01:00Z"),
        processingStatus: "processing",
        hasExtraction: false,
        fullTextChars: null,
        summaryChars: null,
      },
      {
        attachmentId: "att_failed",
        filename: "bad.csv",
        mimeType: "text/csv",
        sizeBytes: 30,
        position: 4,
        createdAt: new Date("2026-07-13T00:02:00Z"),
        processingStatus: "failed",
        hasExtraction: false,
        fullTextChars: null,
        summaryChars: null,
      },
    ])

    const config = await makeService().getConfig(WORKSPACE_ID, "persona_custom_1", CALLER)

    expect(config!.attachments).toEqual([
      {
        id: "att_full",
        filename: "ready.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        processingStatus: "ready",
        contextMode: "full",
        position: 0,
        createdAt: "2026-07-13T00:00:00.000Z",
      },
      {
        id: "att_summary",
        filename: "huge.txt",
        mimeType: "text/plain",
        sizeBytes: 999999,
        processingStatus: "ready",
        contextMode: "summary",
        position: 1,
        createdAt: "2026-07-13T00:00:30.000Z",
      },
      {
        id: "att_name",
        filename: "empty.txt",
        mimeType: "text/plain",
        sizeBytes: 0,
        processingStatus: "ready",
        contextMode: "name_only",
        position: 2,
        createdAt: "2026-07-13T00:00:45.000Z",
      },
      {
        id: "att_processing",
        filename: "wip.pdf",
        mimeType: "application/pdf",
        sizeBytes: 20,
        processingStatus: "processing",
        contextMode: null,
        position: 3,
        createdAt: "2026-07-13T00:01:00.000Z",
      },
      {
        id: "att_failed",
        filename: "bad.csv",
        mimeType: "text/csv",
        sizeBytes: 30,
        processingStatus: "failed",
        contextMode: null,
        position: 4,
        createdAt: "2026-07-13T00:02:00.000Z",
      },
    ])
  })

  it("a built-in config carries an empty attachments list without a repo read", async () => {
    spyOn(PersonaRepository, "resolveEditable").mockResolvedValue({
      kind: "builtin",
      base: getVisibleBuiltInAgentConfig(ARIADNE_AGENT_ID)!,
    })
    spyOn(PersonaConfigDraftRepository, "findByOwner").mockResolvedValue(null)
    spyOn(AgentConfigOverrideRepository, "findActiveDetailByWorkspaceAndAgent").mockResolvedValue(null)
    const list = spyOn(PersonaAttachmentRepository, "listForPersona")

    const config = await makeService().getConfig(WORKSPACE_ID, ARIADNE_AGENT_ID, CALLER)

    expect(config!.attachments).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })
})
