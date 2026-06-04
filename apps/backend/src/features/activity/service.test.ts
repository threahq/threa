import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ActivityTypes, AuthorTypes, CompanionModes, NotificationLevels, StreamTypes, Visibilities } from "@threa/types"
import { ActivityService } from "./service"
import { ActivityRepository } from "./repository"
import { UserRepository } from "../workspaces"
import { StreamRepository, StreamMemberRepository, resolveNotificationLevelsForStream } from "../streams"
import { PersonaRepository } from "../agents"
import { BotRepository } from "../public-api"
import { MessageRepository } from "../messaging"
import * as dbModule from "../../db"
import type { Stream } from "../streams"
import type { Activity } from "./repository"

const WORKSPACE_ID = `ws_test`
const STREAM_ID = `stream_test`
const MESSAGE_ID = `msg_test`
const USER_ID = `usr_actor`
const TARGET_USER_ID = `usr_target`

function fakeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    type: StreamTypes.DM,
    displayName: "Test DM",
    slug: null,
    description: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

function fakeActivity(context: Record<string, unknown>): Activity[] {
  return [
    {
      id: "act_1",
      workspaceId: WORKSPACE_ID,
      userId: TARGET_USER_ID,
      activityType: "message",
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: USER_ID,
      actorType: AuthorTypes.USER,
      context,
      readAt: null,
      createdAt: new Date(),
      isSelf: false,
      emoji: null,
    },
  ]
}

function setupService() {
  // Mock withClient to just call the callback directly with a fake client
  spyOn(dbModule, "withClient").mockImplementation(async (_pool: any, fn: any) => fn({} as any))

  return new ActivityService({ pool: {} as any })
}

describe("ActivityService author name resolution", () => {
  afterEach(() => {
    mock.restore()
  })

  it("resolves user author name from UserRepository", async () => {
    const service = setupService()
    const stream = fakeStream()

    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([{ memberId: TARGET_USER_ID }] as any)
    spyOn(resolveNotificationLevelsForStream as any, "call" as any)
    // Mock resolveNotificationLevelsForStream — it's a standalone function, so mock the module import
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: TARGET_USER_ID, effectiveLevel: NotificationLevels.ACTIVITY },
    ] as any)

    spyOn(UserRepository, "findById").mockResolvedValue({
      id: USER_ID,
      name: "Alice",
      workspaceId: WORKSPACE_ID,
      workosUserId: "workos_1",
      email: "alice@test.com",
      role: "owner",
      slug: "alice",
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
      setupCompleted: true,
      joinedAt: new Date(),
    })

    let capturedContext: Record<string, unknown> | undefined
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      capturedContext = params.context
      return fakeActivity(params.context)
    })

    await service.processMessageNotifications({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: USER_ID,
      actorType: AuthorTypes.USER,
      contentMarkdown: "hello",
      excludeUserIds: new Set(),
    })

    expect(capturedContext?.authorName).toBe("Alice")
    expect(UserRepository.findById).toHaveBeenCalled()
  })

  it("resolves bot author name from BotRepository", async () => {
    const service = setupService()
    const botId = "bot_test"
    const stream = fakeStream()

    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([{ memberId: TARGET_USER_ID }] as any)
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: TARGET_USER_ID, effectiveLevel: NotificationLevels.ACTIVITY },
    ] as any)

    spyOn(BotRepository, "findById").mockResolvedValue({
      id: botId,
      workspaceId: WORKSPACE_ID,
      apiKeyId: null,
      type: "shared",
      ownerUserId: null,
      traits: [],
      slug: "helper-bot",
      name: "Helper Bot",
      description: null,
      avatarEmoji: null,
      avatarUrl: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    let capturedContext: Record<string, unknown> | undefined
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      capturedContext = params.context
      return fakeActivity(params.context)
    })

    await service.processMessageNotifications({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: botId,
      actorType: AuthorTypes.BOT,
      contentMarkdown: "bot reply",
      excludeUserIds: new Set(),
    })

    expect(capturedContext?.authorName).toBe("Helper Bot")
    expect(BotRepository.findById).toHaveBeenCalled()
  })

  it("resolves persona author name from PersonaRepository", async () => {
    const service = setupService()
    const personaId = "persona_test"
    const stream = fakeStream()

    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([{ memberId: TARGET_USER_ID }] as any)
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: TARGET_USER_ID, effectiveLevel: NotificationLevels.ACTIVITY },
    ] as any)

    spyOn(PersonaRepository, "findById").mockResolvedValue({
      id: personaId,
      workspaceId: WORKSPACE_ID,
      slug: "ada",
      name: "Ada",
      description: null,
      avatarEmoji: null,
      systemPrompt: null,
      model: "claude-sonnet-4-5-20250514",
      temperature: null,
      maxTokens: null,
      enabledTools: null,
      managedBy: "workspace",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    let capturedContext: Record<string, unknown> | undefined
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      capturedContext = params.context
      return fakeActivity(params.context)
    })

    await service.processMessageNotifications({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: personaId,
      actorType: AuthorTypes.PERSONA,
      contentMarkdown: "persona reply",
      excludeUserIds: new Set(),
    })

    expect(capturedContext?.authorName).toBe("Ada")
    expect(PersonaRepository.findById).toHaveBeenCalled()
  })

  it("resolves system author as 'Threa'", async () => {
    const service = setupService()
    const stream = fakeStream()

    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([{ memberId: TARGET_USER_ID }] as any)
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: TARGET_USER_ID, effectiveLevel: NotificationLevels.ACTIVITY },
    ] as any)

    let capturedContext: Record<string, unknown> | undefined
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      capturedContext = params.context
      return fakeActivity(params.context)
    })

    await service.processMessageNotifications({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: "system",
      actorType: AuthorTypes.SYSTEM,
      contentMarkdown: "system message",
      excludeUserIds: new Set(),
    })

    expect(capturedContext?.authorName).toBe("Threa")
  })

  it("resolves null for unknown actor type", async () => {
    const service = setupService()
    const stream = fakeStream()

    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([{ memberId: TARGET_USER_ID }] as any)
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: TARGET_USER_ID, effectiveLevel: NotificationLevels.ACTIVITY },
    ] as any)

    let capturedContext: Record<string, unknown> | undefined
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      capturedContext = params.context
      return fakeActivity(params.context)
    })

    await service.processMessageNotifications({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: "unknown_123",
      actorType: "unknown_type",
      contentMarkdown: "mystery",
      excludeUserIds: new Set(),
    })

    expect(capturedContext?.authorName).toBeNull()
  })
})

describe("ActivityService.processSelfMessageActivity", () => {
  afterEach(() => {
    mock.restore()
  })

  it("returns null for non-user actors (bots/personas/system)", async () => {
    const service = setupService()

    const result = await service.processSelfMessageActivity({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: "bot_x",
      actorType: AuthorTypes.BOT,
      contentMarkdown: "hello",
    })

    expect(result).toBeNull()
  })

  it("inserts a self-row with isSelf=true for user messages", async () => {
    const service = setupService()
    const stream = fakeStream()

    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(UserRepository, "findById").mockResolvedValue({ id: USER_ID, name: "Alice" } as any)

    let capturedParams: any
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      capturedParams = params
      return [
        {
          ...fakeActivity(params.context)[0],
          userId: USER_ID,
          isSelf: true,
        },
      ]
    })

    const result = await service.processSelfMessageActivity({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      actorId: USER_ID,
      actorType: AuthorTypes.USER,
      contentMarkdown: "look at me",
    })

    expect(result?.isSelf).toBe(true)
    expect(capturedParams.isSelf).toBe(true)
    expect(capturedParams.activityType).toBe(ActivityTypes.MESSAGE)
    expect(capturedParams.userIds).toEqual([USER_ID])
  })
})

describe("ActivityService.processReactionAdded", () => {
  afterEach(() => {
    mock.restore()
  })

  const MESSAGE_AUTHOR_ID = "usr_author"
  const REACTOR_ID = "usr_reactor"

  function fakeMessage(overrides: Partial<any> = {}) {
    return {
      id: MESSAGE_ID,
      streamId: STREAM_ID,
      authorId: MESSAGE_AUTHOR_ID,
      authorType: AuthorTypes.USER,
      contentMarkdown: "the original message",
      contentJson: {},
      sequence: 1n,
      createdAt: new Date(),
      deletedAt: null,
      reactions: {},
      ...overrides,
    }
  }

  it("creates a notification row for the message author and a self-row for the reactor", async () => {
    const service = setupService()
    const stream = fakeStream({ type: StreamTypes.CHANNEL, visibility: Visibilities.PUBLIC })

    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage() as any)
    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(UserRepository, "findById").mockResolvedValue({ id: REACTOR_ID, name: "Bob" } as any)
    spyOn(StreamMemberRepository, "findByStreamAndMember").mockResolvedValue({
      memberId: MESSAGE_AUTHOR_ID,
    } as any)
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: MESSAGE_AUTHOR_ID, effectiveLevel: NotificationLevels.ACTIVITY },
    ] as any)

    const calls: any[] = []
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      calls.push(params)
      return params.userIds.map((uid: string) => ({
        ...fakeActivity(params.context)[0],
        userId: uid,
        isSelf: params.isSelf ?? false,
        emoji: params.emoji ?? null,
        activityType: params.activityType,
      }))
    })

    const activities = await service.processReactionAdded({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      emoji: ":eyes:",
      actorId: REACTOR_ID,
      actorType: AuthorTypes.USER,
    })

    expect(activities.length).toBe(2)
    expect(calls).toHaveLength(2)

    const authorCall = calls.find((c) => c.userIds[0] === MESSAGE_AUTHOR_ID)
    expect(authorCall).toBeDefined()
    expect(authorCall.activityType).toBe(ActivityTypes.REACTION)
    expect(authorCall.isSelf).toBeFalsy()
    expect(authorCall.emoji).toBe(":eyes:")

    const selfCall = calls.find((c) => c.userIds[0] === REACTOR_ID)
    expect(selfCall).toBeDefined()
    expect(selfCall.isSelf).toBe(true)
    expect(selfCall.emoji).toBe(":eyes:")
  })

  it("notifies the author with the persona's identity but creates no self-row for a persona reactor", async () => {
    const service = setupService()
    const stream = fakeStream({ type: StreamTypes.CHANNEL, visibility: Visibilities.PUBLIC })
    const PERSONA_ID = "persona_ariadne"

    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage() as any)
    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    // Resolved via the persona repo, not the user repo, because actorType is "persona".
    spyOn(PersonaRepository, "findById").mockResolvedValue({ id: PERSONA_ID, name: "Ariadne" } as any)
    spyOn(StreamMemberRepository, "findByStreamAndMember").mockResolvedValue({
      memberId: MESSAGE_AUTHOR_ID,
    } as any)
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: MESSAGE_AUTHOR_ID, effectiveLevel: NotificationLevels.ACTIVITY },
    ] as any)

    const calls: any[] = []
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      calls.push(params)
      return params.userIds.map((uid: string) => ({
        ...fakeActivity(params.context)[0],
        userId: uid,
        isSelf: params.isSelf ?? false,
      }))
    })

    await service.processReactionAdded({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      emoji: ":tada:",
      actorId: PERSONA_ID,
      actorType: AuthorTypes.PERSONA,
    })

    // Author notification fires (attributed to the persona); no self-row — a
    // persona has no Me feed — so there is exactly one insert, targeting the
    // author.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      userIds: [MESSAGE_AUTHOR_ID],
      actorId: PERSONA_ID,
      actorType: AuthorTypes.PERSONA,
      context: { authorName: "Ariadne" },
    })
  })

  it("does not notify the author when the reactor is the author — just creates a self-row", async () => {
    const service = setupService()
    const stream = fakeStream({ type: StreamTypes.CHANNEL, visibility: Visibilities.PUBLIC })

    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage({ authorId: REACTOR_ID }) as any)
    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(UserRepository, "findById").mockResolvedValue({ id: REACTOR_ID, name: "Bob" } as any)

    const calls: any[] = []
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      calls.push(params)
      return params.userIds.map((uid: string) => ({
        ...fakeActivity(params.context)[0],
        userId: uid,
        isSelf: params.isSelf ?? false,
      }))
    })

    await service.processReactionAdded({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      emoji: "✅",
      actorId: REACTOR_ID,
      actorType: AuthorTypes.USER,
    })

    // Only the self-row gets inserted; the "author" path is skipped because
    // the reactor is also the author.
    expect(calls).toHaveLength(1)
    expect(calls[0].isSelf).toBe(true)
    expect(calls[0].userIds).toEqual([REACTOR_ID])
  })

  it("skips author notification when author has muted the stream", async () => {
    const service = setupService()
    const stream = fakeStream({ type: StreamTypes.CHANNEL, visibility: Visibilities.PUBLIC })

    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage() as any)
    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(UserRepository, "findById").mockResolvedValue({ id: REACTOR_ID, name: "Bob" } as any)
    spyOn(StreamMemberRepository, "findByStreamAndMember").mockResolvedValue({
      memberId: MESSAGE_AUTHOR_ID,
    } as any)
    const resolveModule = await import("../streams")
    spyOn(resolveModule, "resolveNotificationLevelsForStream").mockResolvedValue([
      { memberId: MESSAGE_AUTHOR_ID, effectiveLevel: NotificationLevels.MUTED },
    ] as any)

    const calls: any[] = []
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      calls.push(params)
      return params.userIds.map((uid: string) => ({
        ...fakeActivity(params.context)[0],
        userId: uid,
        isSelf: params.isSelf ?? false,
      }))
    })

    await service.processReactionAdded({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      emoji: "👀",
      actorId: REACTOR_ID,
      actorType: AuthorTypes.USER,
    })

    // MUTED → no author notification. Self-row still created.
    expect(calls).toHaveLength(1)
    expect(calls[0].isSelf).toBe(true)
  })

  it("skips author notification when author is a bot (not a workspace user)", async () => {
    const service = setupService()
    const stream = fakeStream({ type: StreamTypes.CHANNEL, visibility: Visibilities.PUBLIC })

    spyOn(MessageRepository, "findById").mockResolvedValue(
      fakeMessage({ authorId: "bot_helper", authorType: AuthorTypes.BOT }) as any
    )
    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    spyOn(UserRepository, "findById").mockResolvedValue({ id: REACTOR_ID, name: "Bob" } as any)

    const calls: any[] = []
    spyOn(ActivityRepository, "insertBatch").mockImplementation(async (_db: any, params: any) => {
      calls.push(params)
      return params.userIds.map((uid: string) => ({
        ...fakeActivity(params.context)[0],
        userId: uid,
        isSelf: params.isSelf ?? false,
      }))
    })

    await service.processReactionAdded({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      emoji: "🚀",
      actorId: REACTOR_ID,
      actorType: AuthorTypes.USER,
    })

    // Bot authors don't get notified (no Activity UI). Self-row still created.
    expect(calls).toHaveLength(1)
    expect(calls[0].isSelf).toBe(true)
  })

  it("returns empty when the message no longer exists", async () => {
    const service = setupService()

    spyOn(MessageRepository, "findById").mockResolvedValue(null)

    const activities = await service.processReactionAdded({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      emoji: ":eyes:",
      actorId: REACTOR_ID,
      actorType: AuthorTypes.USER,
    })

    expect(activities).toEqual([])
  })
})

describe("ActivityService.processSavedReminderFired", () => {
  afterEach(() => {
    mock.restore()
  })

  it("inserts a saved_reminder activity scoped to the saved row id", async () => {
    const service = setupService()

    const insertSpy = spyOn(ActivityRepository, "insert").mockImplementation(async (_db, params) => ({
      id: "act_reminder",
      workspaceId: params.workspaceId,
      userId: params.userId,
      activityType: params.activityType,
      streamId: params.streamId,
      messageId: params.messageId,
      actorId: params.actorId,
      actorType: params.actorType,
      context: params.context ?? {},
      readAt: null,
      createdAt: new Date(),
      isSelf: false,
      emoji: null,
    }))

    const activities = await service.processSavedReminderFired({
      workspaceId: WORKSPACE_ID,
      userId: TARGET_USER_ID,
      savedId: "saved_abc",
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      contentPreview: "Remember this",
      streamName: "#planning",
    })

    expect(activities).toHaveLength(1)
    expect(insertSpy).toHaveBeenCalledTimes(1)
    const call = insertSpy.mock.calls[0][1]
    // Actor is the system, not the save. The dedup index excludes
    // saved_reminder so each fire produces a distinct row via a plain INSERT.
    expect(call.actorId).toBe(AuthorTypes.SYSTEM)
    expect(call.actorType).toBe(AuthorTypes.SYSTEM)
    expect(call.activityType).toBe(ActivityTypes.SAVED_REMINDER)
    expect(call.context).toEqual({
      savedId: "saved_abc",
      contentPreview: "Remember this",
      streamName: "#planning",
    })
  })

  it("mints distinct activity rows for successive saves on the same message", async () => {
    const service = setupService()

    const inserted: Array<{ actorId: string; context: Record<string, unknown> }> = []
    spyOn(ActivityRepository, "insert").mockImplementation(async (_db, params) => {
      inserted.push({ actorId: params.actorId, context: params.context ?? {} })
      return {
        id: `act_${inserted.length}`,
        workspaceId: params.workspaceId,
        userId: params.userId,
        activityType: params.activityType,
        streamId: params.streamId,
        messageId: params.messageId,
        actorId: params.actorId,
        actorType: params.actorType,
        context: params.context ?? {},
        readAt: null,
        createdAt: new Date(),
        isSelf: false,
        emoji: null,
      }
    })

    const common = {
      workspaceId: WORKSPACE_ID,
      userId: TARGET_USER_ID,
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      contentPreview: null,
      streamName: null,
    }

    await service.processSavedReminderFired({ ...common, savedId: "saved_first" })
    await service.processSavedReminderFired({ ...common, savedId: "saved_second" })

    // Actor stays "system" for both — distinctness comes from the DB-level
    // decision to exclude saved_reminder from the dedup index, verified in
    // the repo test. The service contract is that each call carries the
    // originating savedId in context for back-linking.
    expect(inserted).toHaveLength(2)
    expect(inserted.every((i) => i.actorId === AuthorTypes.SYSTEM)).toBe(true)
    expect(inserted.map((i) => i.context.savedId)).toEqual(["saved_first", "saved_second"])
  })

  it("handles null previews and stream names without crashing", async () => {
    const service = setupService()

    const insertSpy = spyOn(ActivityRepository, "insert").mockImplementation(async (_db, params) => ({
      id: "act_reminder",
      workspaceId: params.workspaceId,
      userId: params.userId,
      activityType: params.activityType,
      streamId: params.streamId,
      messageId: params.messageId,
      actorId: params.actorId,
      actorType: params.actorType,
      context: params.context ?? {},
      readAt: null,
      createdAt: new Date(),
      isSelf: false,
      emoji: null,
    }))

    await service.processSavedReminderFired({
      workspaceId: WORKSPACE_ID,
      userId: TARGET_USER_ID,
      savedId: "saved_null",
      streamId: STREAM_ID,
      messageId: MESSAGE_ID,
      contentPreview: null,
      streamName: null,
    })

    expect(insertSpy.mock.calls[0][1].context).toEqual({
      savedId: "saved_null",
      contentPreview: "",
      streamName: null,
    })
  })
})
