import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { HttpError } from "@threa/backend-common"
import { ControlPlaneClient } from "./control-plane-client"

const originalFetch = globalThis.fetch

function makeResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } })
}

describe("ControlPlaneClient error translation", () => {
  let client: ControlPlaneClient

  beforeEach(() => {
    client = new ControlPlaneClient("https://cp.test", "secret")
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test("changeWorkspaceMemberRole forwards CP status + code as HttpError", async () => {
    globalThis.fetch = mock(async () =>
      makeResponse(409, JSON.stringify({ error: "Workspaces must keep at least one owner.", code: "LAST_OWNER" }))
    ) as unknown as typeof fetch

    await expect(
      client.changeWorkspaceMemberRole({
        workspaceId: "ws_1",
        targetUserId: "workos_target",
        actorWorkosUserId: "workos_caller",
        roleSlug: "member",
      })
    ).rejects.toMatchObject({
      name: "HttpError",
      status: 409,
      code: "LAST_OWNER",
      message: "Workspaces must keep at least one owner.",
    })
  })

  test("removeWorkspaceMember forwards CP status + code as HttpError", async () => {
    globalThis.fetch = mock(async () =>
      makeResponse(403, JSON.stringify({ error: "Only workspace owners may manage ownership.", code: "OWNER_ACTION" }))
    ) as unknown as typeof fetch

    const err = await client
      .removeWorkspaceMember({
        workspaceId: "ws_1",
        targetUserId: "workos_target",
        actorWorkosUserId: "workos_caller",
      })
      .catch((e) => e)

    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ status: 403, code: "OWNER_ACTION" })
  })

  test("falls back to a generic message when CP body is not JSON", async () => {
    globalThis.fetch = mock(async () => makeResponse(502, "<html>bad gateway</html>")) as unknown as typeof fetch

    await expect(
      client.changeWorkspaceMemberRole({
        workspaceId: "ws_1",
        targetUserId: "workos_target",
        actorWorkosUserId: "workos_caller",
        roleSlug: "admin",
      })
    ).rejects.toMatchObject({
      name: "HttpError",
      status: 502,
      code: undefined,
      message: "Failed to change workspace member role",
    })
  })
})

describe("ControlPlaneClient invitation protocol", () => {
  let client: ControlPlaneClient
  let requests: Array<{ url: string; method: string | undefined; body: unknown }>

  beforeEach(() => {
    client = new ControlPlaneClient("https://cp.test", "secret")
    requests = []
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return makeResponse(200, JSON.stringify({ ok: true }))
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test("sends a legacy root claim without a colliding child id", async () => {
    await client.notifyInvitationLinkClaimed({
      parentInvitationId: "inv_legacy_root",
      email: "legacy@example.com",
      inviterWorkosUserId: "user_inviter",
    })

    expect(requests).toEqual([
      {
        url: "https://cp.test/internal/invitation-shadows/inv_legacy_root/claim",
        method: "POST",
        body: {
          email: "legacy@example.com",
          inviterWorkosUserId: "user_inviter",
        },
      },
    ])
  })

  test("sends accepted identity and nullable parent state to the acknowledgement endpoint", async () => {
    await client.acknowledgeInvitationAccepted({
      invitationId: "inv_child",
      workspaceId: "ws_1",
      email: "accepted@example.com",
      workosUserId: "workos_accepted",
      parentInvitationId: "inv_parent",
      expiresAt: null,
      maxUses: null,
      useCount: 1,
      revision: 2,
      status: "revoked",
    })

    expect(requests).toEqual([
      {
        url: "https://cp.test/internal/invitation-shadows/inv_child/accepted",
        method: "POST",
        body: {
          workspaceId: "ws_1",
          email: "accepted@example.com",
          workosUserId: "workos_accepted",
          parentInvitationId: "inv_parent",
          expiresAt: null,
          maxUses: null,
          useCount: 1,
          revision: 2,
          status: "revoked",
        },
      },
    ])
  })

  test("patches link state with a serialized expiry", async () => {
    const expiresAt = new Date("2026-10-01T12:34:56.789Z")

    await client.updateInvitationLinkShadow({
      id: "inv_root",
      expiresAt,
      maxUses: 4,
      useCount: 2,
      revision: 3,
      status: "pending",
    })

    expect(requests).toEqual([
      {
        url: "https://cp.test/internal/invitation-shadows/inv_root",
        method: "PATCH",
        body: {
          expiresAt: expiresAt.toISOString(),
          maxUses: 4,
          useCount: 2,
          revision: 3,
          status: "pending",
        },
      },
    ])
  })
})

describe("ControlPlaneClient.getWorkspaceMembership", () => {
  let client: ControlPlaneClient

  beforeEach(() => {
    client = new ControlPlaneClient("https://cp.test", "secret")
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test("returns the member flag from the control plane", async () => {
    globalThis.fetch = mock(async () => makeResponse(200, JSON.stringify({ member: true }))) as unknown as typeof fetch

    await expect(
      client.getWorkspaceMembership({ workspaceId: "ws_1", workosUserId: "workos_user_1" })
    ).resolves.toEqual({ member: true })
  })

  test("coerces a missing/non-true member field to false", async () => {
    globalThis.fetch = mock(async () => makeResponse(200, JSON.stringify({}))) as unknown as typeof fetch

    await expect(
      client.getWorkspaceMembership({ workspaceId: "ws_1", workosUserId: "workos_user_1" })
    ).resolves.toEqual({ member: false })
  })

  test("throws on a non-2xx response so callers fail closed", async () => {
    globalThis.fetch = mock(async () => makeResponse(503, "unavailable")) as unknown as typeof fetch

    await expect(client.getWorkspaceMembership({ workspaceId: "ws_1", workosUserId: "workos_user_1" })).rejects.toThrow(
      "Control-plane returned 503"
    )
  })
})
