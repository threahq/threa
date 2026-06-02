import type { Pool } from "pg"
import { waitlistId, logger } from "@threa/backend-common"
import { WaitlistRepository } from "./repository"

interface Dependencies {
  pool: Pool
}

export class WaitlistService {
  private pool: Pool

  constructor(deps: Dependencies) {
    this.pool = deps.pool
  }

  /**
   * Record a signup. Email is normalized (trimmed + lowercased) so the UNIQUE
   * constraint dedupes case/whitespace variants. Idempotent: a repeat signup
   * returns normally without surfacing that the email already exists.
   */
  async signUp(input: { email: string; source: string | null }): Promise<void> {
    const email = input.email.trim().toLowerCase()
    const created = await WaitlistRepository.insert(this.pool, {
      id: waitlistId(),
      email,
      source: input.source,
    })
    if (created) {
      logger.info({ source: input.source }, "Waitlist signup")
    }
  }
}
