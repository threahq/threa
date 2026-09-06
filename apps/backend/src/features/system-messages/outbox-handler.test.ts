import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { OutboxRepository } from "../../lib/outbox"
import * as cursorLockModule from "@threahq/backend-common"
import { SystemMessageOutboxHandler } from "./outbox-handler"
import type { SystemMessageService } from "./service"
import type { ProcessResult } from "@threahq/backend-common"

function makeFakeCursorLock(onRun?: (result: ProcessResult) => void) {
  return () => ({
    run: mock(async (processor: (cursor: bigint) => Promise<ProcessResult>) => {
      const result = await processor(0n)
      onRun?.(result)
    }),
  })
}

function mockCursorLock(onRun?: (result: ProcessResult) => void) {
  // bun's spyOn resolves mockImplementation arg to `never` for class constructor exports
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(makeFakeCursorLock(onRun))
}

function createHandler() {
  const systemMessageService = {
    notifyOwners: mock(async () => {}),
    notifyMember: mock(async () => {}),
    sendBudgetAlert: mock(async () => {}),
    sendInvitationAccepted: mock(async () => {}),
    findSystemStream: mock(async () => null),
  } as unknown as SystemMessageService

  mockCursorLock()

  const handler = new SystemMessageOutboxHandler({} as any, systemMessageService)

  return { handler, systemMessageService }
}

describe("SystemMessageOutboxHandler", () => {
  afterEach(() => {
    mock.restore()
  })

  it("should pass structured budget alert payload to notification service when budget:alert event is received", async () => {
    const payload = {
      workspaceId: "ws_test",
      alertType: "threshold",
      thresholdPercent: 80,
      currentUsageUsd: 40.5,
      budgetUsd: 50,
      percentUsed: 81,
    }

    const fetchSpy = spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      { id: 1n, eventType: "budget:alert", payload, createdAt: new Date() },
    ] as any)

    const { handler, systemMessageService } = createHandler()
    handler.handle()

    // Let the debouncer fire
    await new Promise((r) => setTimeout(r, 300))

    expect(fetchSpy).toHaveBeenCalled()
    expect(systemMessageService.sendBudgetAlert).toHaveBeenCalledWith(payload)
  })

  it("should delegate invitation:accepted events to sendInvitationAccepted", async () => {
    const payload = {
      workspaceId: "ws_test",
      invitationId: "inv_123",
      email: "new@test.com",
      workosUserId: "workos_user_456",
      userName: "New User",
    }

    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      { id: 1n, eventType: "invitation:accepted", payload, createdAt: new Date() },
    ] as any)

    const { handler, systemMessageService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(systemMessageService.sendInvitationAccepted).toHaveBeenCalledWith(payload)
  })

  it("should skip non-matching event types and advance cursor", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      { id: 1n, eventType: "message:created", payload: {}, createdAt: new Date() },
      { id: 2n, eventType: "stream:created", payload: {}, createdAt: new Date() },
    ] as any)

    const { handler, systemMessageService } = createHandler()
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(systemMessageService.sendBudgetAlert).not.toHaveBeenCalled()
    expect(systemMessageService.notifyOwners).not.toHaveBeenCalled()
  })

  it("should return no_events when batch is empty", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([])

    let result: ProcessResult | undefined
    mockCursorLock((r) => {
      result = r
    })

    const systemMessageService = {
      notifyOwners: mock(async () => {}),
      sendBudgetAlert: mock(async () => {}),
    } as unknown as SystemMessageService
    const handler = new SystemMessageOutboxHandler({} as any, systemMessageService)
    handler.handle()

    await new Promise((r) => setTimeout(r, 300))

    expect(result).toEqual({ status: "no_events" })
  })
})
