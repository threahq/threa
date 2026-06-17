import { createHash } from "node:crypto"

/**
 * One-way hash for a session's callback token. The cleartext token travels only
 * inside the claim handoff to the runner that won the turn (the enclave's sealed
 * assignment or an external bot's sealed claim); the backend persists this digest
 * on `agent_sessions.callback_token_hash` and verifies callbacks against it, so a
 * database read (including the read-only forensics path) can never yield a value
 * that impersonates the runner. Same sha256-at-rest discipline as bot API keys
 * (`bot-api-key-service.ts`). Lives in the neutral agents feature because the
 * binding is a property of the session, shared by every sealed-capable driver.
 */
export function hashCallbackToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
