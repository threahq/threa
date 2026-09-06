import { describe, expect, mock, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { WORKSPACE_ROLE_SLUGS } from "@threahq/types"
import { HttpError } from "../../lib/errors"
import { createWorkspaceAuthzHandlers } from "./handlers"
import type { ApplyMembershipChangeInput, ApplyMembershipRemovalInput, WorkspaceAuthzService } from "./service"

interface MockResponse {
  statusCode: number
  ended: boolean
}

function createRes(): Response & MockResponse {
  const res = {
    statusCode: 0,
    ended: false,
    status(code: number) {
      res.statusCode = code
      return res
    },
    end() {
      res.ended = true
      return res
    },
  }
  return res as unknown as Response & MockResponse
}

function createNext(): { next: NextFunction; calls: unknown[] } {
  const calls: unknown[] = []
  const next: NextFunction = (err) => {
    calls.push(err)
  }
  return { next, calls }
}

function createService() {
  const applyMembershipChange = mock(async (_input: ApplyMembershipChangeInput) => {})
  const applyMembershipRemoval = mock(async (_input: ApplyMembershipRemovalInput) => {})
  return {
    service: { applyMembershipChange, applyMembershipRemoval } as unknown as WorkspaceAuthzService,
    applyMembershipChange,
    applyMembershipRemoval,
  }
}

describe("createWorkspaceAuthzHandlers.syncMembership", () => {
  test("upsert kind: parses body and forwards to applyMembershipChange", async () => {
    const { service, applyMembershipChange, applyMembershipRemoval } = createService()
    const handlers = createWorkspaceAuthzHandlers({ workspaceAuthzService: service })

    const req = {
      body: {
        kind: "upsert",
        workspaceId: "ws_1",
        workosUserId: "user_1",
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        status: "active",
        lastEventAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as Request
    const res = createRes()
    const { next, calls } = createNext()

    await handlers.syncMembership(req, res, next)

    expect(calls).toEqual([])
    expect(applyMembershipChange).toHaveBeenCalledTimes(1)
    expect(applyMembershipRemoval).not.toHaveBeenCalled()
    const arg = applyMembershipChange.mock.calls[0]![0]!
    expect(arg.workspaceId).toBe("ws_1")
    expect(arg.workosUserId).toBe("user_1")
    expect(arg.roleSlugs).toEqual([WORKSPACE_ROLE_SLUGS.ADMIN])
    expect(arg.status).toBe("active")
    expect(arg.lastEventAt.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(res.statusCode).toBe(204)
    expect(res.ended).toBe(true)
  })

  test("remove kind: parses body and forwards to applyMembershipRemoval", async () => {
    const { service, applyMembershipChange, applyMembershipRemoval } = createService()
    const handlers = createWorkspaceAuthzHandlers({ workspaceAuthzService: service })

    const req = {
      body: {
        kind: "remove",
        workspaceId: "ws_1",
        workosUserId: "user_1",
        eventCreatedAt: "2026-01-02T00:00:00.000Z",
      },
    } as unknown as Request
    const res = createRes()
    const { next, calls } = createNext()

    await handlers.syncMembership(req, res, next)

    expect(calls).toEqual([])
    expect(applyMembershipRemoval).toHaveBeenCalledTimes(1)
    expect(applyMembershipChange).not.toHaveBeenCalled()
    const arg = applyMembershipRemoval.mock.calls[0]![0]!
    expect(arg.workspaceId).toBe("ws_1")
    expect(arg.workosUserId).toBe("user_1")
    expect(arg.eventCreatedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z")
    expect(res.statusCode).toBe(204)
  })

  test("rejects an unknown discriminator with HttpError 400", async () => {
    const { service } = createService()
    const handlers = createWorkspaceAuthzHandlers({ workspaceAuthzService: service })

    const req = { body: { kind: "frobnicate", workspaceId: "ws_1" } } as unknown as Request
    const { next, calls } = createNext()

    await handlers.syncMembership(req, createRes(), next)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeInstanceOf(HttpError)
    expect(calls[0]).toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
  })

  test("rejects an upsert with a missing field", async () => {
    const { service } = createService()
    const handlers = createWorkspaceAuthzHandlers({ workspaceAuthzService: service })

    const req = {
      body: {
        kind: "upsert",
        workspaceId: "ws_1",
        workosUserId: "user_1",
        roleSlugs: [WORKSPACE_ROLE_SLUGS.ADMIN],
        // status omitted
        lastEventAt: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as Request
    const { next, calls } = createNext()

    await handlers.syncMembership(req, createRes(), next)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeInstanceOf(HttpError)
  })

  test("rejects a remove with a non-datetime eventCreatedAt", async () => {
    const { service } = createService()
    const handlers = createWorkspaceAuthzHandlers({ workspaceAuthzService: service })

    const req = {
      body: {
        kind: "remove",
        workspaceId: "ws_1",
        workosUserId: "user_1",
        eventCreatedAt: "not-a-date",
      },
    } as unknown as Request
    const { next, calls } = createNext()

    await handlers.syncMembership(req, createRes(), next)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ status: 400 })
  })
})
