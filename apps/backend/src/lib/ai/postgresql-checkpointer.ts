import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres"
import type { Pool } from "pg"

import { logger } from "../logger"

const LANGGRAPH_SCHEMA = "langgraph"

/**
 * Create and initialize a LangGraph PostgreSQL checkpointer. Creates the
 * tables in the `langgraph` schema on first run.
 */
export async function createPostgresCheckpointer(pool: Pool): Promise<PostgresSaver> {
  const checkpointer = new PostgresSaver(pool, undefined, {
    schema: LANGGRAPH_SCHEMA,
  })

  await checkpointer.setup()
  logger.info({ schema: LANGGRAPH_SCHEMA }, "LangGraph checkpointer initialized")

  return checkpointer
}
