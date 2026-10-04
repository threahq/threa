import type { AI } from "@threahq/agent-runtime"
import { EMBEDDING_MODEL_ID } from "./embedding-config"

export interface EmbeddingServiceConfig {
  ai: AI
  model?: string
}

export interface EmbeddingContext {
  workspaceId: string
  userId?: string
  /** Custom function ID for telemetry (e.g., "search-query", "message-embedding") */
  functionId?: string
}

export interface EmbeddingServiceLike {
  embed(text: string, context: EmbeddingContext): Promise<number[]>
  embedBatch(texts: string[], context: EmbeddingContext): Promise<number[][]>
}

export class EmbeddingService implements EmbeddingServiceLike {
  private ai: AI
  private modelId: string

  constructor(config: EmbeddingServiceConfig) {
    this.ai = config.ai
    this.modelId = config.model ?? EMBEDDING_MODEL_ID
  }

  async embed(text: string, context: EmbeddingContext): Promise<number[]> {
    const { value } = await this.ai.embed({
      model: this.modelId,
      value: text,
      telemetry: { functionId: context.functionId ?? "embedding-single" },
      context: { workspaceId: context.workspaceId, userId: context.userId, origin: "system" },
    })
    return value
  }

  async embedBatch(texts: string[], context: EmbeddingContext): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }

    const { value } = await this.ai.embedMany({
      model: this.modelId,
      values: texts,
      telemetry: { functionId: context.functionId ?? "embedding-batch", metadata: { count: texts.length } },
      context: { workspaceId: context.workspaceId, userId: context.userId, origin: "system" },
    })
    return value
  }
}
