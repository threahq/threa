import { afterEach, describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { createPersonaConfigHandlers } from "./persona-config-handlers"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID } from "./built-in-agents"
import type { PersonaConfigService } from "./persona-config-service"
import { HttpError } from "../../lib/errors"

const notFound = () => new HttpError("Persona not found", { status: 404, code: "PERSONA_NOT_FOUND" })

function fakeReq(overrides: Partial<{ params: object; body: object }> = {}): Request {
  return {
    user: { id: "usr_1" },
    workspaceId: "workspace_1",
    params: { personaId: ARIADNE_AGENT_ID },
    body: {},
    ...overrides,
  } as unknown as Request
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    end() {
      return this
    },
  }
  return res as typeof res & Response
}

function makeHandlers(service: Partial<PersonaConfigService>) {
  return createPersonaConfigHandlers({ personaConfigService: service as PersonaConfigService })
}

describe("persona config handlers", () => {
  afterEach(() => mock.restore())

  it("GET list returns the service's persona list", async () => {
    const personas = [{ id: ARIADNE_AGENT_ID, slug: "ariadne", name: "Ariadne", isCustomized: false }]
    const listVisible = mock(async () => personas)
    const res = fakeRes()

    await makeHandlers({ listVisible } as unknown as Partial<PersonaConfigService>).list(fakeReq(), res)

    expect(res.body).toEqual({ personas })
  })

  it("GET config 404s for an id that is not an editable visible built-in", async () => {
    const getConfig = mock(async () => null)
    const handlers = makeHandlers({ getConfig } as unknown as Partial<PersonaConfigService>)

    await expect(handlers.getConfig(fakeReq({ params: { personaId: "persona_x" } }), fakeRes())).rejects.toMatchObject({
      status: 404,
      code: "PERSONA_NOT_FOUND",
    })
  })

  it("GET config returns the service payload verbatim", async () => {
    const payload = { defaults: {}, overridePatch: null, overrideUpdatedAt: null, resolved: {}, draft: null }
    const getConfig = mock(async () => payload)
    const res = fakeRes()

    await makeHandlers({ getConfig } as unknown as Partial<PersonaConfigService>).getConfig(fakeReq(), res)

    expect(res.body).toBe(payload)
  })

  it("PUT override 404s for the internal empty shell before touching the body", async () => {
    const handlers = makeHandlers({})

    await expect(
      handlers.putOverride(fakeReq({ params: { personaId: EMPTY_AGENT_ID }, body: {} }), fakeRes())
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
  })

  it("PUT override rejects a patch carrying a status key (v1 can't disable Ariadne)", async () => {
    const handlers = makeHandlers({})

    const req = fakeReq({ body: { patch: { status: "disabled" }, expectedUpdatedAt: null } })
    await expect(handlers.putOverride(req, fakeRes())).rejects.toMatchObject({ status: 400 })
  })

  it("PUT override surfaces an optimistic-concurrency conflict as 409 with details.current", async () => {
    const current = { patch: { name: "Theirs" }, updatedAt: "2026-07-02T00:00:00.000Z" }
    const setOverride = mock(async () => ({ outcome: "conflict" as const, current }))
    const handlers = makeHandlers({ setOverride } as unknown as Partial<PersonaConfigService>)

    const req = fakeReq({ body: { patch: { name: "Mine" }, expectedUpdatedAt: "2026-07-01T00:00:00.000Z" } })
    await expect(handlers.putOverride(req, fakeRes())).rejects.toMatchObject({
      status: 409,
      code: "PERSONA_OVERRIDE_CONFLICT",
      details: { current },
    })
  })

  it("PUT override returns the persona and fresh updatedAt on success", async () => {
    const persona = { id: ARIADNE_AGENT_ID, slug: "ariadne", name: "Renamed", isCustomized: true }
    const setOverride = mock(async () => ({
      outcome: "written" as const,
      persona,
      updatedAt: "2026-07-02T00:00:00.000Z",
    }))
    const handlers = makeHandlers({ setOverride } as unknown as Partial<PersonaConfigService>)
    const res = fakeRes()

    await handlers.putOverride(fakeReq({ body: { patch: { name: "Renamed" }, expectedUpdatedAt: null } }), res)

    expect(res.body).toEqual({ persona, updatedAt: "2026-07-02T00:00:00.000Z" })
  })

  it("GET revisions surfaces the service's 404 for a non-editable id", async () => {
    const listRevisions = mock(async () => {
      throw notFound()
    })
    const handlers = makeHandlers({ listRevisions } as unknown as Partial<PersonaConfigService>)
    await expect(
      handlers.listRevisions(fakeReq({ params: { personaId: EMPTY_AGENT_ID } }), fakeRes())
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
  })

  it("GET revisions returns the service's revision list", async () => {
    const revisions = [
      { id: "acrev_1", version: 1, patch: { name: "V1" }, createdByKind: "user", createdById: "usr_1", createdAt: "x" },
    ]
    const listRevisions = mock(async () => revisions)
    const res = fakeRes()

    await makeHandlers({ listRevisions } as unknown as Partial<PersonaConfigService>).listRevisions(fakeReq(), res)

    expect(res.body).toEqual({ revisions })
    expect(listRevisions).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID)
  })

  it("POST restore surfaces the service's 404 for a non-editable id", async () => {
    const restoreRevision = mock(async () => {
      throw notFound()
    })
    const handlers = makeHandlers({ restoreRevision } as unknown as Partial<PersonaConfigService>)
    await expect(
      handlers.restoreRevision(
        fakeReq({ params: { personaId: EMPTY_AGENT_ID, revisionId: "acrev_1" }, body: { expectedUpdatedAt: null } }),
        fakeRes()
      )
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
  })

  it("POST restore surfaces an optimistic-concurrency conflict as 409 with details.current", async () => {
    const current = { patch: { name: "Theirs" }, updatedAt: "2026-07-02T00:00:00.000Z" }
    const restoreRevision = mock(async () => ({ outcome: "conflict" as const, current }))
    const handlers = makeHandlers({ restoreRevision } as unknown as Partial<PersonaConfigService>)

    const req = fakeReq({
      params: { personaId: ARIADNE_AGENT_ID, revisionId: "acrev_1" },
      body: { expectedUpdatedAt: "2026-07-01T00:00:00.000Z" },
    })
    await expect(handlers.restoreRevision(req, fakeRes())).rejects.toMatchObject({
      status: 409,
      code: "PERSONA_OVERRIDE_CONFLICT",
      details: { current },
    })
  })

  it("POST restore returns the restored persona and fresh updatedAt on success", async () => {
    const persona = { id: ARIADNE_AGENT_ID, slug: "ariadne", name: "Restored", isCustomized: true }
    const restoreRevision = mock(async () => ({
      outcome: "written" as const,
      persona,
      updatedAt: "2026-07-06T00:00:00.000Z",
    }))
    const handlers = makeHandlers({ restoreRevision } as unknown as Partial<PersonaConfigService>)
    const res = fakeRes()

    await handlers.restoreRevision(
      fakeReq({ params: { personaId: ARIADNE_AGENT_ID, revisionId: "acrev_1" }, body: { expectedUpdatedAt: null } }),
      res
    )

    expect(res.body).toEqual({ persona, updatedAt: "2026-07-06T00:00:00.000Z" })
    expect(restoreRevision).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, "acrev_1", null, "usr_1")
  })

  it("PUT draft surfaces the service's 404 for a non-editable id", async () => {
    const saveDraft = mock(async () => {
      throw notFound()
    })
    const handlers = makeHandlers({ saveDraft } as unknown as Partial<PersonaConfigService>)
    await expect(
      handlers.putDraft(fakeReq({ params: { personaId: EMPTY_AGENT_ID }, body: { patch: {} } }), fakeRes())
    ).rejects.toMatchObject({ status: 404, code: "PERSONA_NOT_FOUND" })
  })

  it("POST create forks and 201s with the new persona", async () => {
    const persona = { id: "persona_new", slug: "helper", name: "Helper", kind: "custom" }
    const forkPersona = mock(async () => persona)
    const res = fakeRes()

    await makeHandlers({ forkPersona } as unknown as Partial<PersonaConfigService>).create(
      fakeReq({ body: { sourcePersonaId: ARIADNE_AGENT_ID, name: "Helper" } }),
      res
    )

    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ persona })
    expect(forkPersona).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, "Helper", "usr_1")
  })

  it("PUT update surfaces an optimistic-concurrency conflict as 409 with details.current", async () => {
    const current = { config: { id: "persona_x" }, updatedAt: "2026-07-02T00:00:00.000Z" }
    const updateCustom = mock(async () => ({ outcome: "conflict" as const, current }))
    const handlers = makeHandlers({ updateCustom } as unknown as Partial<PersonaConfigService>)

    const req = fakeReq({
      params: { personaId: "persona_x" },
      body: {
        config: {
          name: "Helper",
          description: null,
          avatarEmoji: null,
          systemPrompt: "You help.",
          model: "openrouter:anthropic/claude-sonnet-5",
          escalationModel: null,
          temperature: null,
          maxTokens: null,
          enabledTools: [],
          tonePrompt: null,
          brevityPrompt: null,
        },
        expectedUpdatedAt: "2026-07-01T00:00:00.000Z",
      },
    })
    await expect(handlers.update(req, fakeRes())).rejects.toMatchObject({
      status: 409,
      code: "PERSONA_OVERRIDE_CONFLICT",
      details: { current },
    })
  })

  it("POST archive flips status and returns the persona", async () => {
    const persona = { id: "persona_x", slug: "helper", name: "Helper", kind: "custom" }
    const setCustomStatus = mock(async () => persona)
    const res = fakeRes()

    await makeHandlers({ setCustomStatus } as unknown as Partial<PersonaConfigService>).archive(
      fakeReq({ params: { personaId: "persona_x" } }),
      res
    )

    expect(res.body).toEqual({ persona })
    expect(setCustomStatus).toHaveBeenCalledWith("workspace_1", "persona_x", "archived", "usr_1")
  })

  it("PUT draft returns the saved draft state", async () => {
    const draft = { patch: { name: "Draft" }, testStreamId: null, updatedAt: "2026-07-04T00:00:00.000Z" }
    const saveDraft = mock(async () => draft)
    const res = fakeRes()

    await makeHandlers({ saveDraft } as unknown as Partial<PersonaConfigService>).putDraft(
      fakeReq({ body: { patch: { name: "Draft" } } }),
      res
    )

    expect(res.body).toEqual({ draft })
  })

  it("DELETE draft discards and 204s", async () => {
    const discardDraft = mock(async () => undefined)
    const res = fakeRes()

    await makeHandlers({ discardDraft } as unknown as Partial<PersonaConfigService>).deleteDraft(fakeReq(), res)

    expect(res.statusCode).toBe(204)
    expect(discardDraft).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, "usr_1")
  })

  it("POST test-stream returns the ensured stream id", async () => {
    const ensureTestStream = mock(async () => ({ streamId: "stream_test" }))
    const res = fakeRes()

    await makeHandlers({ ensureTestStream } as unknown as Partial<PersonaConfigService>).createTestStream(
      fakeReq(),
      res
    )

    expect(res.body).toEqual({ streamId: "stream_test" })
    expect(ensureTestStream).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, "usr_1")
  })
})
