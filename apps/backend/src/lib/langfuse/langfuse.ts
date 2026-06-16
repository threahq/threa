import { NodeSDK } from "@opentelemetry/sdk-node"
import { LangfuseSpanProcessor } from "@langfuse/otel"
import { CallbackHandler } from "@langfuse/langchain"
import { logger } from "../logger"
import { overrideFetchForLangfuseMinio } from "./hacks"

let otelSdk: NodeSDK | null = null

interface LangfuseConfig {
  secretKey: string
  publicKey: string
  baseUrl: string
}

export function isLangfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY)
}

/**
 * Must be called early in startup, before any LangChain usage. Fails
 * gracefully — on init failure, continues without tracing.
 */
export function initLangfuse(): void {
  overrideFetchForLangfuseMinio()

  if (!isLangfuseEnabled()) {
    logger.info("Langfuse not configured, skipping initialization")
    return
  }

  if (otelSdk) {
    logger.warn("Langfuse already initialized")
    return
  }

  const config: LangfuseConfig = {
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
    baseUrl: process.env.LANGFUSE_BASE_URL || "http://localhost:3100",
  }

  try {
    otelSdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          secretKey: config.secretKey,
          publicKey: config.publicKey,
          baseUrl: config.baseUrl,
        }),
      ],
    })

    otelSdk.start()
    logger.info({ baseUrl: config.baseUrl }, "Langfuse tracing initialized")
  } catch (err) {
    logger.error({ err }, "Failed to initialize Langfuse - continuing without tracing")
    otelSdk = null
  }
}

export async function shutdownLangfuse(): Promise<void> {
  if (otelSdk) {
    await otelSdk.shutdown()
    otelSdk = null
    logger.info("Langfuse tracing shutdown")
  }
}

/**
 * Returns an empty array if Langfuse is not enabled, so callers don't need to check.
 *
 * @example
 * const result = await graph.invoke(input, {
 *   callbacks: getLangfuseCallbacks({
 *     sessionId,
 *     tags: ["companion"],
 *     metadata: { model_id: "anthropic/claude-haiku-4.5" }
 *   }),
 * })
 */
export function getLangfuseCallbacks(params?: {
  sessionId?: string
  userId?: string
  tags?: string[]
  /** Additional metadata to include in traces (e.g., model info for cost tracking) */
  metadata?: Record<string, string | number | boolean>
}): CallbackHandler[] {
  if (!isLangfuseEnabled()) {
    return []
  }
  return [new CallbackHandler(params)]
}
