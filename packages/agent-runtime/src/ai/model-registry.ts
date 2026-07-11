import { readFileSync } from "fs"
import { join } from "path"
import * as yaml from "yaml"

export type InputModality = "text" | "image" | "audio"

export type OutputModality = "text" | "embedding"

/**
 * Streaming capability of a model. `realtime` denotes a continuous
 * WebSocket session (e.g. realtime speech-to-text).
 */
export type StreamingCapability = "realtime"

export interface ModelCapabilities {
  name: string
  inputModalities: InputModality[]
  outputModalities: OutputModality[]
  /** Present for streaming models (e.g. realtime STT). */
  streaming?: StreamingCapability
  /** Billed audio price per hour in USD. Source of truth for audio cost recording (INV-33). */
  audioPricePerHour?: number
}

interface ModelsYaml {
  models: Record<string, ModelCapabilities>
}

export interface ModelRegistry {
  /**
   * Get capabilities for a model by its ID.
   * Returns undefined if model is not registered.
   */
  getCapabilities(modelId: string): ModelCapabilities | undefined

  /**
   * Check if a model supports vision (image input).
   * Returns false for unknown models.
   */
  supportsVision(modelId: string): boolean

  /**
   * Check if a model supports a specific input modality.
   * Returns false for unknown models.
   */
  supportsInputModality(modelId: string, modality: InputModality): boolean

  /**
   * Check if a model supports a specific output modality.
   * Returns false for unknown models.
   */
  supportsOutputModality(modelId: string, modality: OutputModality): boolean

  /**
   * Check if a model accepts audio input (e.g. speech-to-text).
   * Returns false for unknown models.
   */
  supportsAudioInput(modelId: string): boolean

  /**
   * Get the billed audio price per hour (USD) for a model, or undefined
   * if the model is unknown or has no audio pricing.
   */
  getAudioPricePerHour(modelId: string): number | undefined

  /**
   * Check if a model is a plain chat model: text in, text out, and not a
   * realtime/streaming-transcription model. Returns false for unknown models.
   */
  isChatModel(modelId: string): boolean

  /**
   * Get all registered model IDs.
   */
  getModelIds(): string[]
}

export function createModelRegistry(): ModelRegistry {
  const yamlPath = join(__dirname, "models.yaml")
  const content = readFileSync(yamlPath, "utf-8")
  const parsed = yaml.parse(content) as ModelsYaml

  const models = new Map<string, ModelCapabilities>()
  for (const [modelId, capabilities] of Object.entries(parsed.models)) {
    models.set(modelId, capabilities)
  }

  return {
    getCapabilities(modelId: string): ModelCapabilities | undefined {
      return models.get(modelId)
    },

    supportsVision(modelId: string): boolean {
      const caps = models.get(modelId)
      return caps?.inputModalities.includes("image") ?? false
    },

    supportsInputModality(modelId: string, modality: InputModality): boolean {
      const caps = models.get(modelId)
      return caps?.inputModalities.includes(modality) ?? false
    },

    supportsOutputModality(modelId: string, modality: OutputModality): boolean {
      const caps = models.get(modelId)
      return caps?.outputModalities.includes(modality) ?? false
    },

    supportsAudioInput(modelId: string): boolean {
      const caps = models.get(modelId)
      return caps?.inputModalities.includes("audio") ?? false
    },

    getAudioPricePerHour(modelId: string): number | undefined {
      return models.get(modelId)?.audioPricePerHour
    },

    isChatModel(modelId: string): boolean {
      const caps = models.get(modelId)
      if (!caps) return false
      // `streaming` is set only on realtime STT models — its absence is what
      // marks a plain request/response chat model.
      return (
        caps.inputModalities.includes("text") && caps.outputModalities.includes("text") && caps.streaming === undefined
      )
    },

    getModelIds(): string[] {
      return Array.from(models.keys())
    },
  }
}
