import { createHash } from "node:crypto"

/**
 * One-way hash for the per-session callback token (Phase 2.4b). The cleartext
 * token travels only inside the session assignment to the assigned runner;
 * the backend persists this digest and verifies callbacks against it, so a
 * database read (including the read-only forensics path) can never yield a
 * value that impersonates the runner. Same sha256-at-rest discipline as bot
 * API keys (`bot-api-key-service.ts`).
 */
export function hashCallbackToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
