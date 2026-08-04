import type { Request, Response } from "express"
import { z } from "zod"
import { CONTEXT_CATEGORIES, STREAM_CONTEXT_SCOPES } from "@threa/types"
import { validateRequest } from "../../lib/validation"
import type { StreamContextService } from "./service"

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100

const baseQuerySchema = z.object({
  scope: z.enum(STREAM_CONTEXT_SCOPES).default("tree"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
})

/** The narrowing filters, shared by both routes: `occurrenceCount` is counted
 *  over the filtered set, so an expansion that dropped them would return more
 *  rows than the number the user clicked. */
const filterQuerySchema = z.object({
  q: z.string().min(1).max(500).optional(),
  /** Author id — the panel resolves `from:@slug` to an id before calling. */
  from: z.string().min(1).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
})

const listQuerySchema = baseQuerySchema.merge(filterQuerySchema).extend({
  category: z.enum(CONTEXT_CATEGORIES).optional(),
  /** Comma-separated, for a chip that stands for more than one category. */
  categories: z
    .string()
    .min(1)
    .transform((raw) => raw.split(","))
    .pipe(z.array(z.enum(CONTEXT_CATEGORIES)).min(1))
    .optional(),
})

const occurrencesQuerySchema = baseQuerySchema.merge(filterQuerySchema).extend({
  category: z.enum(CONTEXT_CATEGORIES),
  groupKey: z.string().min(1),
})

interface Dependencies {
  streamContextService: StreamContextService
}

export function createStreamContextHandlers({ streamContextService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const query = validateRequest(listQuerySchema, req.query)
      const response = await streamContextService.list({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        streamId: req.params.streamId!,
        scope: query.scope,
        category: query.category,
        categories: query.categories,
        queryText: query.q,
        authorId: query.from,
        before: query.before ? new Date(query.before) : undefined,
        after: query.after ? new Date(query.after) : undefined,
        cursor: query.cursor,
        limit: query.limit,
      })
      res.json(response)
    },

    async listOccurrences(req: Request, res: Response) {
      const query = validateRequest(occurrencesQuerySchema, req.query)
      const response = await streamContextService.listOccurrences({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        streamId: req.params.streamId!,
        scope: query.scope,
        category: query.category,
        groupKey: query.groupKey,
        queryText: query.q,
        authorId: query.from,
        before: query.before ? new Date(query.before) : undefined,
        after: query.after ? new Date(query.after) : undefined,
        cursor: query.cursor,
        limit: query.limit,
      })
      res.json(response)
    },
  }
}
