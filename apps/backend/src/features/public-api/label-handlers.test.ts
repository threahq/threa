import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { LabelActorTypes, LabelableResourceTypes } from "@threa/types"
import type { Label, LabelAssignment } from "@threa/types"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"

// The public label handlers resolve the owning user from the key — a user key
// owns its own labels; a personal bot key owns labels for its owner (a bot never
// owns labels itself, and a shared bot can't apply them). These tests pin that
// contract without a DB.

function personalBot(ownerUserId: string) {
  return { id: "bot_1", workspaceId: "ws_1", type: "personal", ownerUserId, archivedAt: null } as never
}

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
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
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
  afterEach(() => mock.restore())

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

  it("attributes a personal bot key's label to the bot's owner, not the bot", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const upsertByName = mock((_params: unknown) =>
      Promise.resolve(fakeLabel({ creatorActorType: LabelActorTypes.USER, creatorUserId: "usr_owner" }))
    )
    const handlers = createHandlers({
      labelService: { upsertByName } as unknown as PublicApiDeps["labelService"],
    })
    const cap = createResponse()

    await handlers.createLabel(botRequest({ body: { name: "Priority" } }), cap.res)

    // The label is owned by the bot's owner user — never the bot itself.
    expect(upsertByName).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: LabelActorTypes.USER, id: "usr_owner" } })
    )
    expect(cap.body()).toMatchObject({
      data: { creatorActorType: LabelActorTypes.USER, creatorActorId: "usr_owner" },
    })
  })

  it("rejects a shared bot key (no owner to label for)", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue({
      id: "bot_1",
      workspaceId: "ws_1",
      type: "shared",
      ownerUserId: null,
      archivedAt: null,
    } as never)
    const upsertByName = mock((_params: unknown) => Promise.resolve(fakeLabel()))
    const handlers = createHandlers({
      labelService: { upsertByName } as unknown as PublicApiDeps["labelService"],
    })

    await expect(
      handlers.createLabel(botRequest({ body: { name: "Priority" } }), createResponse().res)
    ).rejects.toMatchObject({
      status: 400,
      code: "PERSONAL_BOT_REQUIRED",
    })
    expect(upsertByName).not.toHaveBeenCalled()
  })

  it("applies a personal bot's label-by-name on behalf of its owner", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const assignByName = mock((_params: unknown) =>
      Promise.resolve({
        label: fakeLabel({ creatorActorType: LabelActorTypes.USER, creatorUserId: "usr_owner" }),
        assignment: fakeAssignment({ actorType: LabelActorTypes.USER, userId: "usr_owner" }),
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
        actor: { type: LabelActorTypes.USER, id: "usr_owner" },
        name: "Priority",
        resourceType: "stream",
        resourceId: "stream_1",
      })
    )
    expect(cap.status()).toBe(201)
    expect(cap.body()).toMatchObject({
      data: {
        label: { creatorActorType: LabelActorTypes.USER, creatorActorId: "usr_owner" },
        assignment: { actorType: LabelActorTypes.USER, actorId: "usr_owner", resourceId: "stream_1" },
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
