import { logger } from "../logger"

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

  recordFailure(): void {
    const wasAvailable = this.isAvailable
    this.downUntil = Date.now() + this.cooldownMs
    if (wasAvailable) {
      logger.warn({ cooldownMs: this.cooldownMs }, "Decisions endpoint failed; holding callers on the inference path")
    }
  }
}
