import { logger } from "../logger"
import { DecisionsRequestError } from "./decisions"

/**
 * Shared "is the decisions endpoint answering" flag for the callers that route
 * to it, so one outage costs one timeout rather than one per item.
 *
 * Every decisions caller has an inference path to fall back to, and the
 * fallback is per call with no memory. A provider that stops answering
 * therefore charges `DECISIONS_TIMEOUT_MS` to every item in a batch — 50
 * conversations is ~16 minutes of pure waiting on top of the inference work
 * that then runs. After a failure this holds callers on the inference path for
 * `cooldownMs`, and the first caller past that window probes again.
 *
 * Deliberately coarse: one flag for the endpoint, not per model or workspace,
 * because the failure it exists for is the endpoint being down.
 */
export class DecisionsAvailability {
  private downUntil = 0

  constructor(private readonly cooldownMs = 60_000) {}

  get isAvailable(): boolean {
    return Date.now() >= this.downUntil
  }

  /**
   * A 4xx other than a timeout or rate limit is the endpoint refusing this one
   * request, not the endpoint being down, so it holds nobody else off.
   * Measured: its upstream WAF answers 403 to payloads like `cat /etc/passwd`,
   * which is ordinary input for the sandbox guardian.
   */
  recordFailure(error: unknown): void {
    const requestRejected =
      error instanceof DecisionsRequestError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    if (requestRejected) return
    const wasAvailable = this.isAvailable
    this.downUntil = Date.now() + this.cooldownMs
    if (wasAvailable) {
      logger.warn({ cooldownMs: this.cooldownMs }, "Decisions endpoint failed; holding callers on the inference path")
    }
  }
}
