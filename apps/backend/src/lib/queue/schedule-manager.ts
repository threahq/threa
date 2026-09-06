import type { Pool } from "pg"
import { Ticker } from "@threahq/backend-common"
import { CronRepository } from "./cron-repository"
import { logger } from "../logger"

export interface ScheduleManagerConfig {
  lookaheadSeconds: number // How far ahead to generate ticks (default: 60)
  intervalMs: number // How often to run (default: 10000 = 10s)
  batchSize: number // Max schedules to process per run (default: 100)
}

const DEFAULT_CONFIG: ScheduleManagerConfig = {
  lookaheadSeconds: 60,
  intervalMs: 10000,
  batchSize: 100,
}

/**
 * Pre-generates tick tokens for schedules whose next execution falls inside the
 * lookahead window. Two-phase by design: this runs infrequently (10s) to create
 * future ticks, while QueueManager's ticker (100ms) discovers and executes due
 * ones — so we avoid polling every schedule every 100ms.
 */
export class ScheduleManager {
  private readonly ticker: Ticker
  private readonly config: ScheduleManagerConfig

  constructor(
    private readonly pool: Pool,
    config: Partial<ScheduleManagerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.ticker = new Ticker({
      name: "schedule-manager",
      intervalMs: this.config.intervalMs,
      maxConcurrency: 1,
    })
  }

  start(): void {
    this.ticker.start(() => this.generateTicks())
    logger.info(
      {
        lookaheadSeconds: this.config.lookaheadSeconds,
        intervalMs: this.config.intervalMs,
        batchSize: this.config.batchSize,
      },
      "ScheduleManager started"
    )
  }

  async stop(): Promise<void> {
    this.ticker.stop()
    await this.ticker.drain()
    logger.info("ScheduleManager stopped")
  }

  private async generateTicks(): Promise<void> {
    try {
      const schedules = await CronRepository.findSchedulesNeedingTicks(this.pool, {
        lookaheadSeconds: this.config.lookaheadSeconds,
        limit: this.config.batchSize,
      })

      if (schedules.length === 0) {
        return
      }

      // Deterministic executeAt preserves one canonical tick per schedule
      // interval across all nodes.
      const ticksToCreate = schedules.map((schedule) => {
        return {
          scheduleId: schedule.id,
          queueName: schedule.queueName,
          payload: schedule.payload,
          workspaceId: schedule.workspaceId,
          executeAt: schedule.nextTickNeededAt,
          intervalSeconds: schedule.intervalSeconds,
        }
      })

      const ticks = await CronRepository.createTicks(this.pool, {
        schedules: ticksToCreate,
      })

      logger.debug(
        {
          schedulesProcessed: schedules.length,
          ticksCreated: ticks.length,
          lookaheadSeconds: this.config.lookaheadSeconds,
        },
        "Generated cron ticks"
      )
    } catch (err) {
      logger.error({ err }, "Failed to generate cron ticks")
    }
  }

  isRunning(): boolean {
    return this.ticker.isRunning()
  }
}
