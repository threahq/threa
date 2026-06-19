import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { LabelActorTypes, LabelableResourceTypes } from "@threa/types"
import type { Label, LabelAssignment } from "@threa/types"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"

// The public label handlers resolve a label actor from the key (user vs bot) and
// pass it through to the shared label services, then serialize with explicit
// `actorType`/`actorId` wire fields. These tests pin that contract without a DB.

interface CapturedResponse {
  res: Response
  status: () => number
  body: () => unknown
}

function createResponse(): CapturedResponse {
  let statusCode = 200
  let body: unknown
  const res = {} as Response
  res.status = mock((code: number) => {
    statusCode = code
    return res
  }) as unknown as Response["status"]
  res.json = mock((payload: unknown) => {
    body = payload
    return res
  }) as unknown as Response["json"]
  res.end = mock(() => res) as unknown as Response["end"]
  return { res, status: () => statusCode, body: () => body }
}

function fakeLabel(overrides: Partial<Label> = {}): Label {
  return {
    id: "label_1",
    workspaceId: "ws_1",
    creatorActorType: LabelActorTypes.USER,
    creatorUserId: "usr_1",
    name: "Priority",
    slug: "priority",
    color: "#ff0000",
    emoji: null,
    description: null,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  }
}

function fakeAssignment(overrides: Partial<LabelAssignment> = {}): LabelAssignment {
  return {
    labelId: "label_1",
    resourceType: LabelableResourceTypes.STREAM,
    resourceId: "stream_1",
    actorType: LabelActorTypes.USER,
    userId: "usr_1",
    workspaceId: "ws_1",
    assignedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  }
}

function createHandlers(overrides: Partial<PublicApiDeps> = {}): ReturnType<typeof createPublicApiHandlers> {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
    ...overrides,
  }
  return createPublicApiHandlers(deps)
}

function userRequest(extra: Partial<Request> = {}): Request {
  return {
    workspaceId: "ws_1",
    params: { labelId: "label_1" },
    body: {},
    query: {},
    userApiKey: { id: "key_1" },
    user: { id: "usr_1", name: "Tester" },
    ...extra,
  } as unknown as Request
}

function botRequest(extra: Partial<Request> = {}): Request {
  return {
    workspaceId: "ws_1",
    params: { labelId: "label_1" },
    body: {},
    query: {},
    botApiKey: { id: "bkey_1", botId: "bot_1" },
    ...extra,
  } as unknown as Request
}

describe("public API label handlers", () => {
  it("upserts a label by name attributed to the user actor for a user key", async () => {
    const upsertByName = mock((_params: unknown) => Promise.resolve(fakeLabel()))
    const handlers = createHandlers({
      labelService: { upsertByName } as unknown as PublicApiDeps["labelService"],
    })
    const cap = createResponse()

    await handlers.createLabel(userRequest({ body: { name: "Priority", color: "#ff0000" } }), cap.res)

    expect(upsertByName).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: LabelActorTypes.USER, id: "usr_1" }, name: "Priority" })
    )
    expect(cap.status()).toBe(201)
    expect(cap.body()).toMatchObject({
      data: { creatorActorType: LabelActorTypes.USER, creatorActorId: "usr_1" },
    })
  })

  it("upserts a label attributed to the bot actor for a bot key", async () => {
    const upsertByName = mock((_params: unknown) =>
      Promise.resolve(fakeLabel({ creatorActorType: LabelActorTypes.BOT, creatorUserId: "bot_1" }))
    )
    const handlers = createHandlers({
      labelService: { upsertByName } as unknown as PublicApiDeps["labelService"],
    })
    const cap = createResponse()

    await handlers.createLabel(botRequest({ body: { name: "Priority" } }), cap.res)

    expect(upsertByName).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: LabelActorTypes.BOT, id: "bot_1" } })
    )
    expect(cap.body()).toMatchObject({
      data: { creatorActorType: LabelActorTypes.BOT, creatorActorId: "bot_1" },
    })
  })

  it("applies a label by name and returns the resolved label plus assignment", async () => {
    const assignByName = mock((_params: unknown) =>
      Promise.resolve({
        label: fakeLabel({ creatorActorType: LabelActorTypes.BOT, creatorUserId: "bot_1" }),
        assignment: fakeAssignment({ actorType: LabelActorTypes.BOT, userId: "bot_1" }),
      })
    )
    const handlers = createHandlers({
      labelAssignmentService: { assignByName } as unknown as PublicApiDeps["labelAssignmentService"],
    })
    const cap = createResponse()

    await handlers.assignLabel(
      botRequest({ body: { name: "Priority", resourceType: "stream", resourceId: "stream_1" } }),
      cap.res
    )

    expect(assignByName).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: LabelActorTypes.BOT, id: "bot_1" },
        name: "Priority",
        resourceType: "stream",
        resourceId: "stream_1",
      })
    )
    expect(cap.status()).toBe(201)
    expect(cap.body()).toMatchObject({
      data: {
        label: { creatorActorType: LabelActorTypes.BOT, creatorActorId: "bot_1" },
        assignment: { actorType: LabelActorTypes.BOT, actorId: "bot_1", resourceId: "stream_1" },
      },
    })
  })

  it("unassigns by name via query params and returns 204", async () => {
    const unassignByName = mock((_params: unknown) => Promise.resolve())
    const handlers = createHandlers({
      labelAssignmentService: { unassignByName } as unknown as PublicApiDeps["labelAssignmentService"],
    })
    const cap = createResponse()

    await handlers.unassignLabel(
      userRequest({ query: { name: "Priority", resourceType: "stream", resourceId: "stream_1" } as Request["query"] }),
      cap.res
    )

    expect(unassignByName).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: LabelActorTypes.USER, id: "usr_1" },
        name: "Priority",
        resourceType: "stream",
        resourceId: "stream_1",
      })
    )
    expect(cap.status()).toBe(204)
  })

  it("lists the catalog scoped to the key actor", async () => {
    const handlers = createHandlers({
      labelService: {
        listForActor: mock(() => Promise.resolve([fakeLabel()])),
      } as unknown as PublicApiDeps["labelService"],
      labelAssignmentService: {
        listForViewer: mock(() => Promise.resolve([fakeAssignment()])),
      } as unknown as PublicApiDeps["labelAssignmentService"],
    })
    const cap = createResponse()

    await handlers.listLabels(userRequest(), cap.res)

    expect(cap.body()).toMatchObject({
      data: {
        labels: [expect.objectContaining({ id: "label_1", creatorActorId: "usr_1" })],
        assignments: [expect.objectContaining({ resourceId: "stream_1", actorId: "usr_1" })],
      },
    })
  })
})
