import { timingSafeEqual } from "node:crypto"
import { HttpError } from "@threa/backend-common"
import { hashCallbackToken } from "./callback-token"
import { SessionStatuses, type AgentSession } from "./session-repository"

/**
 * The guards every sealed session callback must pass, shared by every
 * sealed-capable driver — the enclave's session callbacks today and an
 * owner-granted external bot harness's sealed `/steps`/`/complete` next (§2.6).
 * They live in the neutral agents feature because each one is a property of the
 * `agent_sessions` row, not of any one transport: only the header the token
 * rides in differs between drivers, so each call site reads its own header and
 * hands the value here.
 */

function assertSessionStatus(
  session: AgentSession | null,
  allowed: readonly AgentSession["status"][]
): asserts session is AgentSession {
  if (!session) throw new HttpError("Session not found", { status: 404, code: "SESSION_NOT_FOUND" })
  if (!allowed.includes(session.status)) {
    throw new HttpError("Session is not running", { status: 409, code: "SESSION_NOT_RUNNING" })
  }
}

export function assertSessionRunning(session: AgentSession | null): asserts session is AgentSession {
  assertSessionStatus(session, [SessionStatuses.RUNNING])
}

export function assertSessionRunningOrCompleted(session: AgentSession | null): asserts session is AgentSession {
  assertSessionStatus(session, [SessionStatuses.RUNNING, SessionStatuses.COMPLETED])
}

export function assertSessionRunningOrFailed(session: AgentSession | null): asserts session is AgentSession {
  assertSessionStatus(session, [SessionStatuses.RUNNING, SessionStatuses.FAILED])
}

export function assertSessionRunningOrCompletedOrFailed(session: AgentSession | null): asserts session is AgentSession {
  assertSessionStatus(session, [SessionStatuses.RUNNING, SessionStatuses.COMPLETED, SessionStatuses.FAILED])
}

/**
 * Bind a sealed callback to the runner the session was assigned to (Phase 2.4b,
 * E2EE-21). The cleartext token was minted at claim and delivered only inside
 * the sealed assignment/claim to the winning instance — possession proves the
 * caller is that runner, a stronger binding than a self-reported instance id
 * that any workspace-key holder could copy. The row holds only the sha256
 * digest, so the presented value is hashed before the timing-safe compare (both
 * sides are fixed-length hex). The token is mandatory: an absent token — like a
 * NULL row hash, which no token can match — is rejected outright.
 */
export function verifyCallbackToken(
  session: Pick<AgentSession, "callbackTokenHash">,
  presented: string | undefined
): void {
  if (!presented) {
    throw new HttpError("Missing callback token", { status: 403, code: "CALLBACK_TOKEN_MISSING" })
  }
  const expected = session.callbackTokenHash
  const presentedHash = Buffer.from(hashCallbackToken(presented))
  if (!expected || !timingSafeEqual(presentedHash, Buffer.from(expected))) {
    throw new HttpError("Callback token mismatch", { status: 403, code: "CALLBACK_TOKEN_MISMATCH" })
  }
}

/**
 * A seal under any generation other than the one the assignment/claim prescribed
 * would persist as a permanently undecryptable row — reject it loudly so the turn
 * fails visibly instead (E2EE-21). Sessions dispatched before the column shipped
 * (NULL) are exempt.
 */
export function assertReplyKeyGeneration(
  session: Pick<AgentSession, "replyKeyGeneration">,
  envelope: { keyGeneration: number } | undefined
): void {
  if (!envelope || session.replyKeyGeneration == null) return
  if (envelope.keyGeneration !== session.replyKeyGeneration) {
    throw new HttpError(
      `Sealed payload uses key generation ${envelope.keyGeneration}; this session seals under ${session.replyKeyGeneration}`,
      { status: 400, code: "E2E_WRONG_KEY_GENERATION" }
    )
  }
}
