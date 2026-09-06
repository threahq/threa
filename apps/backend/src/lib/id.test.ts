/**
 * ID Generation Unit Tests
 *
 * Tests verify IDs have correct prefix format and ULID structure.
 */

import { describe, test, expect } from "bun:test"
import {
  userId,
  workspaceId,
  streamId,
  eventId,
  messageId,
  attachmentId,
  personaId,
  notificationId,
  invitationId,
  sessionId,
  stepId,
} from "@threahq/backend-common"

describe("ID Generation", () => {
  describe("format", () => {
    const testCases = [
      { name: "userId", fn: userId, prefix: "usr" },
      { name: "workspaceId", fn: workspaceId, prefix: "ws" },
      { name: "streamId", fn: streamId, prefix: "stream" },
      { name: "eventId", fn: eventId, prefix: "event" },
      { name: "messageId", fn: messageId, prefix: "msg" },
      { name: "attachmentId", fn: attachmentId, prefix: "attach" },
      { name: "personaId", fn: personaId, prefix: "persona" },
      { name: "notificationId", fn: notificationId, prefix: "notif" },
      { name: "invitationId", fn: invitationId, prefix: "inv" },
      { name: "sessionId", fn: sessionId, prefix: "session" },
      { name: "stepId", fn: stepId, prefix: "step" },
    ]

    for (const { name, fn, prefix } of testCases) {
      test(`${name} has correct prefix '${prefix}_'`, () => {
        const id = fn()
        expect(id.startsWith(`${prefix}_`)).toBe(true)
      })

      test(`${name} has valid ULID format after prefix`, () => {
        const id = fn()
        const parts = id.split("_")
        expect(parts.length).toBe(2)

        const ulid = parts[1]
        // ULID is 26 characters using Crockford's base32
        expect(ulid.length).toBe(26)
        // Valid Crockford base32 characters (uppercase, no I, L, O, U)
        expect(ulid).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/)
      })
    }
  })
})
