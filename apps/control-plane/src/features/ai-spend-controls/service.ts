import type { Pool } from "pg"
import { HttpError, withTransaction, logger, OutboxRepository } from "@threahq/backend-common"
import { AI_OPERATOR_CEILING_DEFAULT_USD } from "@threahq/types"
import { AISpendControlsRepository, type AISpendControls } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

export const OUTBOX_AI_SPEND_CONTROLS_SYNC = "ai_spend_controls_sync"

/** Carries only the workspace; the handler re-reads current state, so replays are idempotent. */
export interface AISpendControlsSyncPayload extends Record<string, unknown> {
  workspaceId: string
}

const DEFAULT_AI_SPEND_CONTROLS: AISpendControls = {
  operatorCeilingUsd: AI_OPERATOR_CEILING_DEFAULT_USD,
  operatorAiDisabled: false,
}

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
}

/** Source of truth for the operator's per-workspace AI ceiling and off switch. */
export class AISpendControlsService {
  private pool: Pool
  private regionalClient: RegionalClient

  constructor({ pool, regionalClient }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
  }

  async get(workspaceId: string): Promise<AISpendControls> {
    return (await AISpendControlsRepository.find(this.pool, workspaceId)) ?? DEFAULT_AI_SPEND_CONTROLS
  }

  /** The controls write and the fan-out outbox event commit atomically (INV-7). */
  async set(workspaceId: string, controls: AISpendControls): Promise<AISpendControls> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }
    await withTransaction(this.pool, async (client) => {
      await AISpendControlsRepository.upsert(client, workspaceId, controls)
      await OutboxRepository.insert(client, OUTBOX_AI_SPEND_CONTROLS_SYNC, {
        workspaceId,
      } satisfies AISpendControlsSyncPayload)
    })
    return this.get(workspaceId)
  }

  /** Outbox handler: push the current controls, not event-time state, to the workspace's region. */
  async syncToRegion(payload: AISpendControlsSyncPayload): Promise<void> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, payload.workspaceId)
    if (!workspace) {
      logger.warn({ workspaceId: payload.workspaceId }, "AI spend controls sync skipped: workspace not in registry")
      return
    }
    const controls = await this.get(payload.workspaceId)
    await this.regionalClient.syncAISpendControls(workspace.region, { workspaceId: payload.workspaceId, ...controls })
  }
}
