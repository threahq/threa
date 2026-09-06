import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { SavedSuggestionStatuses } from "@threahq/types"
import { SavedSuggestionsService, type SavedItemCreator } from "./service"
import { SuggestionExtractor, type ExtractedItem } from "./extractor"
import { SavedSuggestionsRepository, type SavedSuggestion } from "./repository"
import { UserRepository } from "../workspaces"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"
import { SUGGESTION_CONFIDENCE_FLOOR } from "./config"

const WS = "ws_1"
const STREAM = "stream_1"
const CONV = "conv_1"
const NOW = new Date("2026-06-12T12:00:00.000Z")

function fakeSuggestion(overrides: Partial<SavedSuggestion> = {}): SavedSuggestion {
  return {
    id: "sugg_1",
    workspaceId: WS,
    userId: "usr_1",
    streamId: STREAM,
    conversationId: CONV,
    title: "Send the invoice",
    context: "Acme is waiting on it",
    sourceMessageIds: ["msg_1"],
    dueAt: null,
    confidence: 0.9,
    status: SavedSuggestionStatuses.SUGGESTED,
    savedMessageId: null,
    createdAt: NOW,
    statusChangedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function fakeExtracted(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    title: "Send the invoice",
    context: "Acme is waiting on it",
    assigneeUserId: "usr_1",
    dueAtIso: null,
    sourceMessageIds: ["msg_1"],
    confidence: 0.9,
    ...overrides,
  }
}

function setup(options: { extracted: ExtractedItem[] }) {
  spyOn(dbModule, "withClient").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  spyOn(UserRepository, "findByIds").mockResolvedValue([
    { id: "usr_1", name: "Chris" },
    { id: "usr_2", name: "Dana" },
  ] as any)
  spyOn(SavedSuggestionsRepository, "findTitlesByConversation").mockResolvedValue([])
  spyOn(SavedSuggestionsRepository, "findDismissedTitlesByStream").mockResolvedValue([])
  spyOn(SuggestionExtractor.prototype, "extract").mockResolvedValue(options.extracted)
  const savedItemCreator: SavedItemCreator = { createStandalone: mock(async () => ({ id: "saved_new" }) as any) }
  const service = new SavedSuggestionsService({
    pool: {} as any,
    extractor: new SuggestionExtractor({} as any, {} as any),
    savedItemCreator,
  })
  return { service, savedItemCreator }
}

describe("SavedSuggestionsService.collectForConversation", () => {
  afterEach(() => mock.restore())

  const collectParams = {
    workspaceId: WS,
    streamId: STREAM,
    conversationId: CONV,
    participantIds: ["usr_1", "usr_2"],
    formattedMessages: "<message>hi</message>",
  }

  it("persists confidently-attributed items and broadcasts to each assignee", async () => {
    const { service } = setup({ extracted: [fakeExtracted({ assigneeUserId: "usr_1" })] })
    const insertSpy = spyOn(SavedSuggestionsRepository, "insertMany").mockResolvedValue([fakeSuggestion()])
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const count = await service.collectForConversation(collectParams)

    expect(count).toBe(1)
    expect(insertSpy.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ userId: "usr_1", title: "Send the invoice", streamId: STREAM }),
    ])
    const [, eventType, payload] = outboxSpy.mock.calls[0]!
    expect(eventType).toBe("saved_suggestion:upserted")
    expect(payload).toMatchObject({ workspaceId: WS, targetUserId: "usr_1" })
  })

  it("drops items below the confidence floor", async () => {
    const { service } = setup({ extracted: [fakeExtracted({ confidence: SUGGESTION_CONFIDENCE_FLOOR - 0.01 })] })
    const insertSpy = spyOn(SavedSuggestionsRepository, "insertMany").mockResolvedValue([])

    const count = await service.collectForConversation(collectParams)

    expect(count).toBe(0)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("drops items whose assignee is not a listed participant (no guessing)", async () => {
    const { service } = setup({
      extracted: [fakeExtracted({ assigneeUserId: "usr_outsider" }), fakeExtracted({ assigneeUserId: null })],
    })
    const insertSpy = spyOn(SavedSuggestionsRepository, "insertMany").mockResolvedValue([])

    const count = await service.collectForConversation(collectParams)

    expect(count).toBe(0)
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

describe("SavedSuggestionsService.accept", () => {
  afterEach(() => mock.restore())

  it("creates a standalone saved item from the suggestion and marks it accepted", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(SavedSuggestionsRepository, "findById").mockResolvedValue(fakeSuggestion({ dueAt: NOW }))
    const updateSpy = spyOn(SavedSuggestionsRepository, "updateStatus").mockResolvedValue(
      fakeSuggestion({ status: SavedSuggestionStatuses.ACCEPTED, savedMessageId: "saved_new" })
    )
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const createStandalone = mock(
      async (_params: { title: string; note: string | null; remindAt: Date | null }) =>
        ({
          id: "saved_new",
        }) as any
    )
    const service = new SavedSuggestionsService({
      pool: {} as any,
      extractor: {} as any,
      savedItemCreator: { createStandalone },
    })

    const result = await service.accept({ workspaceId: WS, userId: "usr_1", suggestionId: "sugg_1" })

    // Title + extracted context + dueAt flow into the saved item.
    expect(createStandalone.mock.calls[0]![0]).toMatchObject({
      title: "Send the invoice",
      note: "Acme is waiting on it",
      remindAt: NOW,
    })
    // updateStatus is guarded on the suggested→accepted transition (idempotent).
    expect(updateSpy.mock.calls[0]![4]).toMatchObject({
      status: SavedSuggestionStatuses.ACCEPTED,
      expectedStatus: SavedSuggestionStatuses.SUGGESTED,
      savedMessageId: "saved_new",
    })
    expect(result.saved.id).toBe("saved_new")
    expect(result.suggestion.status).toBe(SavedSuggestionStatuses.ACCEPTED)
  })

  it("409s when the suggestion is already resolved", async () => {
    spyOn(SavedSuggestionsRepository, "findById").mockResolvedValue(
      fakeSuggestion({ status: SavedSuggestionStatuses.ACCEPTED })
    )
    const service = new SavedSuggestionsService({
      pool: {} as any,
      extractor: {} as any,
      savedItemCreator: { createStandalone: mock(async () => ({}) as any) },
    })

    await expect(service.accept({ workspaceId: WS, userId: "usr_1", suggestionId: "sugg_1" })).rejects.toMatchObject({
      status: 409,
    })
  })

  it("404s when the suggestion does not exist", async () => {
    spyOn(SavedSuggestionsRepository, "findById").mockResolvedValue(null)
    const service = new SavedSuggestionsService({
      pool: {} as any,
      extractor: {} as any,
      savedItemCreator: { createStandalone: mock(async () => ({}) as any) },
    })

    await expect(service.accept({ workspaceId: WS, userId: "usr_1", suggestionId: "missing" })).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe("SavedSuggestionsService.dismiss", () => {
  afterEach(() => mock.restore())

  it("marks dismissed and broadcasts", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    const updateSpy = spyOn(SavedSuggestionsRepository, "updateStatus").mockResolvedValue(
      fakeSuggestion({ status: SavedSuggestionStatuses.DISMISSED })
    )
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const service = new SavedSuggestionsService({
      pool: {} as any,
      extractor: {} as any,
      savedItemCreator: { createStandalone: mock(async () => ({}) as any) },
    })

    const view = await service.dismiss({ workspaceId: WS, userId: "usr_1", suggestionId: "sugg_1" })

    expect(updateSpy.mock.calls[0]![4]).toMatchObject({
      status: SavedSuggestionStatuses.DISMISSED,
      expectedStatus: SavedSuggestionStatuses.SUGGESTED,
    })
    expect(outboxSpy.mock.calls[0]![1]).toBe("saved_suggestion:upserted")
    expect(view.status).toBe(SavedSuggestionStatuses.DISMISSED)
  })

  it("404s when nothing was in the suggested state", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(SavedSuggestionsRepository, "updateStatus").mockResolvedValue(null)
    const service = new SavedSuggestionsService({
      pool: {} as any,
      extractor: {} as any,
      savedItemCreator: { createStandalone: mock(async () => ({}) as any) },
    })

    await expect(service.dismiss({ workspaceId: WS, userId: "usr_1", suggestionId: "sugg_1" })).rejects.toMatchObject({
      status: 404,
    })
  })
})
