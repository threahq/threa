import { afterEach, describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import type { Readable } from "node:stream"
import { createPersonaConfigHandlers } from "./persona-config-handlers"
import { ARIADNE_AGENT_ID, EMPTY_AGENT_ID } from "./built-in-agents"
import type { PersonaConfigService } from "./persona-config-service"
import type { AvatarService } from "../workspaces"
import { HttpError } from "../../lib/errors"

const notFound = () => new HttpError("Persona not found", { status: 404, code: "PERSONA_NOT_FOUND" })

// The caller the handlers resolve from `req.user.role` (admin here) and pass to
// the service (user-scoped-personas).
const CALLER = { userId: "usr_1", isAdmin: true }

function fakeReq(overrides: Partial<{ params: object; body: object; user: object }> = {}): Request {
  return {
    user: { id: "usr_1", role: "admin" },
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
    headersSent: false,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
    set(key: string, value: string) {
      this.headers[key] = value
      return this
    },
    end() {
      return this
    },
  }
  return res as typeof res & Response
}

function makeHandlers(service: Partial<PersonaConfigService>, avatarService: Partial<AvatarService> = {}) {
  return createPersonaConfigHandlers({
    personaConfigService: service as PersonaConfigService,
    avatarService: avatarService as AvatarService,
  })
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
    expect(listRevisions).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, CALLER)
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
    expect(restoreRevision).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, "acrev_1", null, CALLER)
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
    expect(forkPersona).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, "Helper", "workspace", CALLER)
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
    expect(setCustomStatus).toHaveBeenCalledWith("workspace_1", "persona_x", "archived", CALLER)
  })

  it("resolves a non-admin member as isAdmin: false at the handler boundary", async () => {
    // A regression resolving every member as admin would bypass the service's
    // workspace-persona authorization without failing any admin-role test.
    const persona = { id: "persona_x", slug: "helper", name: "Helper", kind: "personal" }
    const setCustomStatus = mock(async () => persona)
    const res = fakeRes()

    await makeHandlers({ setCustomStatus } as unknown as Partial<PersonaConfigService>).archive(
      fakeReq({ params: { personaId: "persona_x" }, user: { id: "usr_1", role: "member" } }),
      res
    )

    expect(setCustomStatus).toHaveBeenCalledWith("workspace_1", "persona_x", "archived", {
      userId: "usr_1",
      isAdmin: false,
    })
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
    expect(discardDraft).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, CALLER)
  })

  it("POST test-stream returns the ensured stream id", async () => {
    const ensureTestStream = mock(async () => ({ streamId: "stream_test" }))
    const res = fakeRes()

    await makeHandlers({ ensureTestStream } as unknown as Partial<PersonaConfigService>).createTestStream(
      fakeReq(),
      res
    )

    expect(res.body).toEqual({ streamId: "stream_test" })
    expect(ensureTestStream).toHaveBeenCalledWith("workspace_1", ARIADNE_AGENT_ID, CALLER)
  })
})

describe("persona config avatar handlers", () => {
  afterEach(() => mock.restore())

  const CUSTOM_ID = "persona_custom_1"

  function avatarReq(overrides: { params?: object; file?: unknown } = {}): Request {
    return {
      user: { id: "usr_1", role: "admin" },
      workspaceId: "workspace_1",
      params: { personaId: CUSTOM_ID },
      body: {},
      ...overrides,
    } as unknown as Request
  }

  it("POST avatar 400s when no file is uploaded", async () => {
    const res = fakeRes()
    await makeHandlers({}, {}).uploadAvatar(avatarReq(), res)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: "No file uploaded" })
  })

  it("POST avatar processes the image, commits the pointer, and deletes the old files", async () => {
    const setCustomAvatar = mock(async () => ({
      persona: { id: CUSTOM_ID, avatarUrl: "avatars/workspace_1/personas/persona_custom_1/222" },
      previousAvatarUrl: "avatars/workspace_1/personas/persona_custom_1/111",
      updatedAt: "2026-07-12T10:00:00.000Z",
    }))
    const uploadRawForPersona = mock(async () => "avatars/workspace_1/personas/persona_custom_1/222.original")
    const rawKeyToBasePath = mock((k: string) => k.replace(/\.original$/, ""))
    const processImages = mock(async () => new Map())
    const uploadImages = mock(async () => {})
    const deleteRawFile = mock(async () => {})
    const deleteAvatarFiles = mock(async () => {})

    const handlers = makeHandlers({ setCustomAvatar } as unknown as Partial<PersonaConfigService>, {
      uploadRawForPersona,
      rawKeyToBasePath,
      processImages,
      uploadImages,
      deleteRawFile,
      deleteAvatarFiles,
    })
    const res = fakeRes()
    await handlers.uploadAvatar(avatarReq({ file: { buffer: Buffer.from("img") } }), res)

    const basePath = "avatars/workspace_1/personas/persona_custom_1/222"
    expect(uploadImages).toHaveBeenCalled()
    expect(deleteRawFile).toHaveBeenCalledWith("avatars/workspace_1/personas/persona_custom_1/222.original")
    expect(setCustomAvatar).toHaveBeenCalledWith("workspace_1", CUSTOM_ID, basePath, CALLER)
    // Old files cleaned up only after the commit succeeds.
    expect(deleteAvatarFiles).toHaveBeenCalledWith("avatars/workspace_1/personas/persona_custom_1/111")
    expect(res.body).toEqual({
      persona: { id: CUSTOM_ID, avatarUrl: basePath },
      updatedAt: "2026-07-12T10:00:00.000Z",
    })
  })

  it("POST avatar cleans up the orphaned processed files when the write is rejected (non-custom)", async () => {
    const setCustomAvatar = mock(async () => {
      throw new HttpError("This action is only available for custom personas", {
        status: 400,
        code: "PERSONA_NOT_CUSTOM",
      })
    })
    const uploadRawForPersona = mock(async () => "avatars/workspace_1/personas/persona_custom_1/222.original")
    const rawKeyToBasePath = mock((k: string) => k.replace(/\.original$/, ""))
    const processImages = mock(async () => new Map())
    const uploadImages = mock(async () => {})
    const deleteRawFile = mock(async () => {})
    const deleteAvatarFiles = mock(async () => {})

    const handlers = makeHandlers({ setCustomAvatar } as unknown as Partial<PersonaConfigService>, {
      uploadRawForPersona,
      rawKeyToBasePath,
      processImages,
      uploadImages,
      deleteRawFile,
      deleteAvatarFiles,
    })

    await expect(
      handlers.uploadAvatar(avatarReq({ file: { buffer: Buffer.from("img") } }), fakeRes())
    ).rejects.toMatchObject({
      code: "PERSONA_NOT_CUSTOM",
    })
    expect(deleteAvatarFiles).toHaveBeenCalledWith("avatars/workspace_1/personas/persona_custom_1/222")
  })

  it("DELETE avatar clears the pointer and deletes the old files", async () => {
    const setCustomAvatar = mock(async () => ({
      persona: { id: CUSTOM_ID, avatarUrl: null },
      previousAvatarUrl: "avatars/workspace_1/personas/persona_custom_1/111",
      updatedAt: "2026-07-12T10:00:00.000Z",
    }))
    const deleteAvatarFiles = mock(async () => {})
    const handlers = makeHandlers({ setCustomAvatar } as unknown as Partial<PersonaConfigService>, {
      deleteAvatarFiles,
    })
    const res = fakeRes()
    await handlers.removeAvatar(avatarReq(), res)

    expect(setCustomAvatar).toHaveBeenCalledWith("workspace_1", CUSTOM_ID, null, CALLER)
    expect(deleteAvatarFiles).toHaveBeenCalledWith("avatars/workspace_1/personas/persona_custom_1/111")
    expect(res.body).toEqual({ persona: { id: CUSTOM_ID, avatarUrl: null }, updatedAt: "2026-07-12T10:00:00.000Z" })
  })

  it("DELETE avatar skips the S3 delete when the persona had no avatar", async () => {
    const setCustomAvatar = mock(async () => ({
      persona: { id: CUSTOM_ID, avatarUrl: null },
      previousAvatarUrl: null,
    }))
    const deleteAvatarFiles = mock(async () => {})
    const handlers = makeHandlers({ setCustomAvatar } as unknown as Partial<PersonaConfigService>, {
      deleteAvatarFiles,
    })
    await handlers.removeAvatar(avatarReq(), fakeRes())
    expect(deleteAvatarFiles).not.toHaveBeenCalled()
  })

  it("GET avatar sets an immutable cache header and pipes the stream", async () => {
    const fakeStream = { on: mock(() => {}), pipe: mock(() => {}) }
    const streamPersonaAvatarFile = mock(async () => fakeStream as unknown as Readable)
    const handlers = makeHandlers({}, { streamPersonaAvatarFile })
    const res = fakeRes()

    await handlers.serveAvatarFile(
      {
        params: { workspaceId: "workspace_1", personaId: CUSTOM_ID, file: "222.256.webp" },
      } as unknown as Request,
      res
    )

    expect(res.headers["Content-Type"]).toBe("image/webp")
    expect(res.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable")
    expect(fakeStream.pipe).toHaveBeenCalledWith(res)
  })

  it("GET avatar 404s when the file doesn't match the read pattern", async () => {
    const streamPersonaAvatarFile = mock(async () => null)
    const handlers = makeHandlers({}, { streamPersonaAvatarFile })
    const res = fakeRes()

    await handlers.serveAvatarFile(
      {
        params: { workspaceId: "workspace_1", personaId: CUSTOM_ID, file: "../secret" },
      } as unknown as Request,
      res
    )

    expect(res.statusCode).toBe(404)
  })

  it("POST attachment 400s when no file is uploaded", async () => {
    const addAttachment = mock(async () => ({}) as never)
    const handlers = makeHandlers({ addAttachment } as unknown as Partial<PersonaConfigService>)

    await expect(
      handlers.uploadAttachment(fakeReq({ params: { personaId: CUSTOM_ID } }), fakeRes())
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(addAttachment).not.toHaveBeenCalled()
  })

  it("POST attachment passes the buffered file to the service and returns 201", async () => {
    const item = {
      id: "att_1",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      processingStatus: "processing",
      contextMode: null,
      position: 0,
      createdAt: "2026-07-13T00:00:00.000Z",
    }
    const addAttachment = mock(async () => item)
    const handlers = makeHandlers({ addAttachment } as unknown as Partial<PersonaConfigService>)
    const req = fakeReq({ params: { personaId: CUSTOM_ID } })
    ;(req as unknown as { file: unknown }).file = {
      buffer: Buffer.from("hello world!"),
      originalname: "notes.txt",
      mimetype: "text/plain",
      size: 12,
    }
    const res = fakeRes()

    await handlers.uploadAttachment(req, res)

    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ attachment: item })
    expect(addAttachment).toHaveBeenCalledWith("workspace_1", CUSTOM_ID, CALLER, {
      buffer: expect.any(Buffer),
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    })
  })

  it("DELETE attachment authorizes via the service and 204s", async () => {
    const removeAttachment = mock(async () => undefined)
    const handlers = makeHandlers({ removeAttachment } as unknown as Partial<PersonaConfigService>)
    const res = fakeRes()

    await handlers.deleteAttachment(fakeReq({ params: { personaId: CUSTOM_ID, attachmentId: "att_1" } }), res)

    expect(res.statusCode).toBe(204)
    expect(removeAttachment).toHaveBeenCalledWith("workspace_1", CUSTOM_ID, "att_1", CALLER)
  })

  it("DELETE attachment 400s an empty attachmentId param (INV-55)", async () => {
    const removeAttachment = mock(async () => undefined)
    const handlers = makeHandlers({ removeAttachment } as unknown as Partial<PersonaConfigService>)

    await expect(
      handlers.deleteAttachment(fakeReq({ params: { personaId: CUSTOM_ID, attachmentId: "" } }), fakeRes())
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(removeAttachment).not.toHaveBeenCalled()
  })
})
