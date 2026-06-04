import { describe, expect, it, mock } from "bun:test"
import { ATTACHMENT_SAFETY_STATUSES, AttachmentSafetyStatuses, SHAREABLE_SAFETY_STATUSES } from "@threa/types"
import { createMalwareScanner, isAttachmentSafeForSharing, safetyStatusBlockReason } from "./upload-safety-policy"

describe("attachment sharing safety", () => {
  it("allows clean and E2E-unscanned attachments, blocks pending and quarantined", () => {
    expect(isAttachmentSafeForSharing(AttachmentSafetyStatuses.CLEAN)).toBe(true)
    // E2E ciphertext is unscannable but it's the owner's own bytes — downloadable.
    expect(isAttachmentSafeForSharing(AttachmentSafetyStatuses.E2E_UNSCANNED)).toBe(true)
    expect(isAttachmentSafeForSharing(AttachmentSafetyStatuses.PENDING_SCAN)).toBe(false)
    expect(isAttachmentSafeForSharing(AttachmentSafetyStatuses.QUARANTINED)).toBe(false)
  })

  it("predicate agrees with SHAREABLE_SAFETY_STATUSES for every status", () => {
    // The predicate and the race-safe attachToMessage SQL both read this one
    // allowlist; adding a status to only one place breaks this (INV-33).
    for (const status of ATTACHMENT_SAFETY_STATUSES) {
      expect(isAttachmentSafeForSharing(status)).toBe((SHAREABLE_SAFETY_STATUSES as readonly string[]).includes(status))
    }
  })

  it("returns status-specific block reasons", () => {
    expect(safetyStatusBlockReason(AttachmentSafetyStatuses.PENDING_SCAN)).toBe("Attachment is pending malware scan")
    expect(safetyStatusBlockReason(AttachmentSafetyStatuses.QUARANTINED)).toBe(
      "Attachment is quarantined due to malware scan"
    )
    expect(safetyStatusBlockReason(AttachmentSafetyStatuses.CLEAN)).toBe("")
    expect(safetyStatusBlockReason(AttachmentSafetyStatuses.E2E_UNSCANNED)).toBe("")
  })
})

describe("createMalwareScanner", () => {
  it("returns clean when scanning is disabled", async () => {
    const getObjectRange = mock(() => Promise.resolve(Buffer.from("")))
    const scanner = createMalwareScanner(
      {
        getObjectRange,
      } as any,
      {
        malwareScanEnabled: false,
      }
    )

    const result = await scanner.scan({
      storagePath: "ws_1/attach_1/safe.png",
      filename: "safe.png",
      mimeType: "image/png",
    })

    expect(result).toEqual({ status: AttachmentSafetyStatuses.CLEAN })
    expect(getObjectRange).not.toHaveBeenCalled()
  })

  it("returns clean when no malware signature is found", async () => {
    const getObjectRange = mock(() => Promise.resolve(Buffer.from("")))
    const scanner = createMalwareScanner(
      {
        getObjectRange,
      } as any,
      {
        malwareScanEnabled: true,
      }
    )

    const result = await scanner.scan({
      storagePath: "ws_1/attach_1/payload.exe",
      filename: "payload.exe",
      mimeType: "application/octet-stream",
    })

    expect(result).toEqual({ status: AttachmentSafetyStatuses.CLEAN })
    expect(getObjectRange).toHaveBeenCalled()
  })

  it("quarantines EICAR signature matches", async () => {
    const scanner = createMalwareScanner(
      {
        getObjectRange: mock(() => Promise.resolve(Buffer.from("X5O!P%@AP test"))),
      } as any,
      {
        malwareScanEnabled: true,
      }
    )

    const result = await scanner.scan({
      storagePath: "ws_1/attach_1/suspicious.txt",
      filename: "suspicious.txt",
      mimeType: "text/plain",
    })

    expect(result).toEqual({
      status: AttachmentSafetyStatuses.QUARANTINED,
      reason: "signature_match",
    })
  })
})
