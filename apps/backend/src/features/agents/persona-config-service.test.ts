import { describe, expect, it, mock } from "bun:test"
import type { Pool, QueryConfig, QueryResult } from "pg"
import type { ModelRegistry, ModelCapabilities } from "@threa/agent-runtime"
import { HttpError } from "../../lib/errors"
import { PersonaConfigService } from "./persona-config-service"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID, BUILT_IN_AGENTS } from "./built-in-agents"

const WORKSPACE_ID = "ws_01"
const DEFAULT_MODEL = BUILT_IN_AGENTS[ARIADNE_AGENT_ID].model
const OVERRIDE_MODEL = "openrouter:anthropic/claude-sonnet-5"

const REGISTRY_MODELS: Record<string, ModelCapabilities> = {
  [DEFAULT_MODEL]: { name: "Claude Sonnet 4.6", inputModalities: ["text", "image"], outputModalities: ["text"] },
  [OVERRIDE_MODEL]: { name: "Claude Sonnet 5", inputModalities: ["text", "image"], outputModalities: ["text"] },
  "openrouter:openai/text-embedding-3-small": {
    name: "Text Embedding 3 Small",
    inputModalities: ["text"],
    outputModalities: ["embedding"],
  },
  "elevenlabs:scribe-v2-realtime": {
    name: "ElevenLabs Scribe v2 Realtime",
    inputModalities: ["audio"],
    outputModalities: ["text"],
    streaming: "realtime",
  },
}

function createRegistry(): ModelRegistry {
  return {
    getCapabilities: (id) => REGISTRY_MODELS[id],
    supportsVision: (id) => REGISTRY_MODELS[id]?.inputModalities.includes("image") ?? false,
    supportsInputModality: (id, m) => REGISTRY_MODELS[id]?.inputModalities.includes(m) ?? false,
    supportsOutputModality: (id, m) => REGISTRY_MODELS[id]?.outputModalities.includes(m) ?? false,
    supportsAudioInput: (id) => REGISTRY_MODELS[id]?.inputModalities.includes("audio") ?? false,
    getAudioPricePerHour: () => undefined,
    getModelIds: () => Object.keys(REGISTRY_MODELS),
  }
}

interface FakeDb {
  pool: Pool
  queries: { text: string; values: unknown[] }[]
}

/**
 * Fake pool: captures writes; SELECTs return `overrideRows` so the post-write
 * re-read (and list) sees the given override state.
 */
function createFakeDb(overrideRows: { agent_id: string; patch: unknown }[] = []): FakeDb {
  const queries: { text: string; values: unknown[] }[] = []
  const pool = {
    query: mock(async (q: unknown) => {
      const config = q as QueryConfig
      queries.push({ text: config.text ?? "", values: [...(config.values ?? [])] })
      if ((config.text ?? "").trimStart().startsWith("SELECT")) {
        return { rows: overrideRows, rowCount: overrideRows.length } as unknown as QueryResult
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult
    }),
  } as unknown as Pool
  return { pool, queries }
}

function createService(db: FakeDb) {
  return new PersonaConfigService({ pool: db.pool, modelRegistry: createRegistry() })
}

describe("PersonaConfigService.listWorkspacePersonas", () => {
  it("lists visible personas with override applied and chat-only model options", async () => {
    const db = createFakeDb([{ agent_id: ARIADNE_AGENT_ID, patch: { model: OVERRIDE_MODEL } }])
    const service = createService(db)

    const result = await service.listWorkspacePersonas(WORKSPACE_ID)

    const ariadne = result.personas.find((p) => p.id === ARIADNE_AGENT_ID)
    expect(ariadne).toEqual({
      id: ARIADNE_AGENT_ID,
      slug: "ariadne",
      name: "Ariadne",
      description: BUILT_IN_AGENTS[ARIADNE_AGENT_ID].description,
      avatarEmoji: BUILT_IN_AGENTS[ARIADNE_AGENT_ID].avatarEmoji,
      model: OVERRIDE_MODEL,
      defaultModel: DEFAULT_MODEL,
      status: "active",
      overriddenFields: ["model"],
    })

    // Internal shell agents are not workspace-configurable surfaces.
    expect(result.personas.some((p) => p.id === EMPTY_AGENT_ID)).toBe(false)

    // Embeddings and realtime STT are not assignable persona models.
    expect(result.availableModels.map((m) => m.id).sort()).toEqual([DEFAULT_MODEL, OVERRIDE_MODEL].sort())
  })
})

describe("PersonaConfigService.updatePersonaModel", () => {
  it("merges a model override patch and returns the resolved summary", async () => {
    const db = createFakeDb([{ agent_id: ARIADNE_AGENT_ID, patch: { model: OVERRIDE_MODEL } }])
    const service = createService(db)

    const persona = await service.updatePersonaModel(WORKSPACE_ID, ARIADNE_AGENT_ID, OVERRIDE_MODEL)

    const write = db.queries.find((q) => q.text.includes("INSERT INTO agent_config_overrides"))
    expect(write).toBeDefined()
    expect(write!.text).toContain("ON CONFLICT (workspace_id, agent_id)")
    expect(write!.values).toContain(JSON.stringify({ model: OVERRIDE_MODEL }))
    expect(persona.model).toBe(OVERRIDE_MODEL)
    expect(persona.overriddenFields).toEqual(["model"])
  })

  it("clears the override with model: null and returns the default", async () => {
    const db = createFakeDb([])
    const service = createService(db)

    const persona = await service.updatePersonaModel(WORKSPACE_ID, ARIADNE_AGENT_ID, null)

    const write = db.queries.find((q) => q.text.includes("UPDATE agent_config_overrides"))
    expect(write).toBeDefined()
    expect(write!.values).toContainEqual(["model"])
    expect(persona.model).toBe(DEFAULT_MODEL)
    expect(persona.overriddenFields).toEqual([])
  })

  it("rejects a model that is not in the capability registry", async () => {
    const db = createFakeDb([])
    const service = createService(db)

    expect(service.updatePersonaModel(WORKSPACE_ID, ARIADNE_AGENT_ID, "openrouter:fake/nonexistent")).rejects.toThrow(
      HttpError
    )
    expect(db.queries.some((q) => q.text.includes("INSERT"))).toBe(false)
  })

  it("rejects non-chat models (embeddings, realtime STT)", async () => {
    const db = createFakeDb([])
    const service = createService(db)

    expect(
      service.updatePersonaModel(WORKSPACE_ID, ARIADNE_AGENT_ID, "openrouter:openai/text-embedding-3-small")
    ).rejects.toThrow("not an assignable chat model")
    expect(service.updatePersonaModel(WORKSPACE_ID, ARIADNE_AGENT_ID, "elevenlabs:scribe-v2-realtime")).rejects.toThrow(
      "not an assignable chat model"
    )
  })

  it("404s for unknown and internal personas", async () => {
    const db = createFakeDb([])
    const service = createService(db)

    expect(service.updatePersonaModel(WORKSPACE_ID, "persona_system_unknown", OVERRIDE_MODEL)).rejects.toThrow(
      "Persona not found"
    )
    expect(service.updatePersonaModel(WORKSPACE_ID, EMPTY_AGENT_ID, OVERRIDE_MODEL)).rejects.toThrow(
      "Persona not found"
    )
  })
})
