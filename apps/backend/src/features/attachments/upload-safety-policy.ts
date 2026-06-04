import { AttachmentSafetyStatuses, SHAREABLE_SAFETY_STATUSES, type AttachmentSafetyStatus } from "@threa/types"
import type { StorageProvider } from "../../lib/storage/s3-client"
import { logger } from "../../lib/logger"

export interface AttachmentSafetyPolicy {
  malwareScanEnabled: boolean
}

export interface MalwareScanInput {
  storagePath: string
  filename: string
  mimeType: string
}

export const MALWARE_SCAN_REASONS = ["signature_match", "scan_error"] as const
export type MalwareScanReason = (typeof MALWARE_SCAN_REASONS)[number]

export const MalwareScanReasons = {
  SIGNATURE_MATCH: "signature_match",
  SCAN_ERROR: "scan_error",
} as const satisfies Record<string, MalwareScanReason>

export interface MalwareScanResult {
  status: AttachmentSafetyStatus
  reason?: MalwareScanReason
}

export interface MalwareScanner {
  scan(input: MalwareScanInput): Promise<MalwareScanResult>
}

const SCAN_HEAD_BYTES = 8 * 1024

const MALWARE_SIGNATURES = ["EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "X5O!P%@AP"] as const

export function isAttachmentSafeForSharing(safetyStatus: AttachmentSafetyStatus): boolean {
  // Scanned-clean or E2E ciphertext (unscannable but the owner's own bytes).
  // SHAREABLE_SAFETY_STATUSES is the single source of truth this and the
  // race-safe `attachToMessage` SQL filter both read from (INV-33).
  return (SHAREABLE_SAFETY_STATUSES as readonly AttachmentSafetyStatus[]).includes(safetyStatus)
}

export function safetyStatusBlockReason(safetyStatus: AttachmentSafetyStatus): string {
  switch (safetyStatus) {
    case AttachmentSafetyStatuses.PENDING_SCAN:
      return "Attachment is pending malware scan"
    case AttachmentSafetyStatuses.QUARANTINED:
      return "Attachment is quarantined due to malware scan"
    case AttachmentSafetyStatuses.CLEAN:
    case AttachmentSafetyStatuses.E2E_UNSCANNED:
      return ""
  }
}

function containsMalwareSignature(buffer: Buffer): boolean {
  const preview = buffer.toString("utf8").toUpperCase()
  return MALWARE_SIGNATURES.some((signature) => preview.includes(signature))
}

export function createMalwareScanner(storage: StorageProvider, policy: AttachmentSafetyPolicy): MalwareScanner {
  return {
    async scan(input: MalwareScanInput): Promise<MalwareScanResult> {
      if (!policy.malwareScanEnabled) {
        return { status: AttachmentSafetyStatuses.CLEAN }
      }

      try {
        const head = await storage.getObjectRange(input.storagePath, 0, SCAN_HEAD_BYTES - 1)

        if (containsMalwareSignature(head)) {
          return {
            status: AttachmentSafetyStatuses.QUARANTINED,
            reason: MalwareScanReasons.SIGNATURE_MATCH,
          }
        }

        return { status: AttachmentSafetyStatuses.CLEAN }
      } catch (err) {
        logger.warn(
          {
            err,
            storagePath: input.storagePath,
            filename: input.filename,
          },
          "Malware scan failed; quarantining attachment"
        )

        return {
          status: AttachmentSafetyStatuses.QUARANTINED,
          reason: MalwareScanReasons.SCAN_ERROR,
        }
      }
    },
  }
}
