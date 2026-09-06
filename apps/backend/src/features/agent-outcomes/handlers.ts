import type { Request, Response } from "express"
import { z } from "zod"
import { AGENT_OUTCOME_KINDS, AGENT_OUTCOME_SCOPES, AGENT_OUTCOME_STATES } from "@threahq/types"
import { validateRequest } from "../../lib/validation"
import type { AgentOutcomeService } from "./service"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

const listQuerySchema = z.object({
  /** Comma-separated stream ids; under the default `tree` scope each also matches its threads. */
  streams: z.string().min(1).optional(),
  scope: z.enum(AGENT_OUTCOME_SCOPES).default("tree"),
  state: z.enum(AGENT_OUTCOME_STATES).default("all"),
  kind: z.enum(AGENT_OUTCOME_KINDS).optional(),
  q: z.string().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
  withCount: z.enum(["true", "false"]).default("false"),
})

interface Dependencies {
  agentOutcomeService: AgentOutcomeService
}

/**
 * Cross-stream read over follow-ups and delegations. No stream access check
 * here: scope is a filter, not a gate — the statement's own access predicate
 * decides what a viewer can see, so an unreadable `?streams=` id narrows to
 * nothing instead of 404ing (and cannot probe for existence).
 */
export function createAgentOutcomeHandlers({ agentOutcomeService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const query = validateRequest(listQuerySchema, req.query)
      const streamIds = query.streams
        ?.split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)

      const response = await agentOutcomeService.list({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        streamIds: streamIds?.length ? streamIds : undefined,
        scope: query.scope,
        state: query.state,
        kind: query.kind,
        queryText: query.q,
        cursor: query.cursor,
        limit: query.limit,
        withCount: query.withCount === "true",
      })
      res.json(response)
    },
  }
}
