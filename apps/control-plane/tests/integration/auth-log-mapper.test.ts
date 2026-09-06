import { describe, expect, test } from "bun:test"
import type { WorkosEvent } from "@threahq/backend-common"
import { mapWorkosEventToAuthLogRow } from "../../src/features/auth-log"

function event(partial: { id: string; event: string; createdAt?: string; data: Record<string, unknown> }): WorkosEvent {
  return {
    id: partial.id,
    event: partial.event,
    createdAt: partial.createdAt ?? "2026-07-18T10:00:00.000Z",
    context: undefined,
    data: partial.data,
  } as unknown as WorkosEvent
}

describe("mapWorkosEventToAuthLogRow", () => {
  test("authentication.password_failed → denied, extracts identity, content-free detail", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_pw_failed",
        event: "authentication.password_failed",
        data: {
          email: "alice@example.com",
          userId: "user_alice",
          ipAddress: "203.0.113.9",
          userAgent: "Mozilla/5.0",
          type: "password",
          status: "failed",
          error: { code: "invalid_credentials", message: "wrong password for alice" },
        },
      })
    )

    expect(row).toEqual({
      occurredAt: new Date("2026-07-18T10:00:00.000Z"),
      workosEventId: "event_pw_failed",
      eventType: "authentication.password_failed",
      workosUserId: "user_alice",
      email: "alice@example.com",
      organizationId: null,
      impersonatorEmail: null,
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      outcome: "denied",
      detail: { type: "password", status: "failed", errorCode: "invalid_credentials" },
    })
    // The free-text error message is content and must never be persisted.
    expect(JSON.stringify(row.detail)).not.toContain("wrong password")
  })

  test("authentication.radar_risk_detected → success (a flagged but successful sign-in)", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_radar",
        event: "authentication.radar_risk_detected",
        data: { email: "bob@example.com", userId: "user_bob", action: "login", ipAddress: "198.51.100.2" },
      })
    )
    expect(row.outcome).toBe("success")
    expect(row.detail).toEqual({ action: "login" })
  })

  test("authentication.sso_succeeded reads organizationId from the nested sso object", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_sso",
        event: "authentication.sso_succeeded",
        data: {
          email: "frank@example.com",
          userId: "user_frank",
          sso: { connectionId: "conn_1", organizationId: "org_sso" },
          ipAddress: "203.0.113.9",
        },
      })
    )
    expect(row.outcome).toBe("success")
    expect(row.workosUserId).toBe("user_frank")
    expect(row.organizationId).toBe("org_sso")
  })

  test("session.created maps impersonator → impersonatorEmail (success)", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_session",
        event: "session.created",
        data: {
          object: "session",
          id: "session_1",
          userId: "user_carol",
          organizationId: "org_acme",
          ipAddress: "192.0.2.5",
          userAgent: "curl/8",
          authMethod: "impersonation",
          status: "active",
          impersonator: { email: "operator@workos.com", reason: "customer requested debugging of billing" },
        },
      })
    )
    expect(row.outcome).toBe("success")
    expect(row.workosUserId).toBe("user_carol")
    expect(row.organizationId).toBe("org_acme")
    expect(row.impersonatorEmail).toBe("operator@workos.com")
    expect(row.detail).toEqual({ authMethod: "impersonation", status: "active" })
    // The impersonation reason is operator free-text — never persisted.
    expect(JSON.stringify(row)).not.toContain("customer requested")
  })

  test("user.created reads user id from data.id (object==='user')", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_user",
        event: "user.created",
        data: { object: "user", id: "user_dave", email: "dave@example.com" },
      })
    )
    expect(row.outcome).toBe("success")
    expect(row.workosUserId).toBe("user_dave")
    expect(row.email).toBe("dave@example.com")
    expect(row.detail).toBeNull()
  })

  test("invitation.created carries email + organizationId", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_invite",
        event: "invitation.created",
        data: { object: "invitation", id: "inv_1", email: "eve@example.com", organizationId: "org_beta" },
      })
    )
    expect(row.email).toBe("eve@example.com")
    expect(row.organizationId).toBe("org_beta")
    expect(row.workosUserId).toBeNull()
    expect(row.outcome).toBe("success")
  })

  test("api_key.created reads org from owner.id", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_apikey",
        event: "api_key.created",
        data: { object: "api_key", id: "key_1", owner: { type: "organization", id: "org_gamma" } },
      })
    )
    expect(row.organizationId).toBe("org_gamma")
    expect(row.outcome).toBe("success")
  })

  test("api_key.revoked reads org from owner.id and maps success", () => {
    const row = mapWorkosEventToAuthLogRow(
      event({
        id: "event_apikey_revoked",
        event: "api_key.revoked",
        data: { object: "api_key", id: "key_1", owner: { type: "organization", id: "org_gamma" } },
      })
    )
    expect(row.eventType).toBe("api_key.revoked")
    expect(row.organizationId).toBe("org_gamma")
    expect(row.outcome).toBe("success")
  })
})
