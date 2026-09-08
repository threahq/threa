import { claudeModelSuggestions, piModelSuggestions, type ModelSuggestion } from "@threahq/harness-client"
import { die } from "./errors"
import { commandPath } from "./shell"

export interface SpawnRuntimeDefinition {
  kind: string
  label: string
  binary: string
  binEnv: string
  /** Levels the binary accepts at launch: `claude --effort`, `pi --thinking`. */
  thinkingLevels: readonly string[]
  /** The runtime's own model catalog, read from ITS config so a desk on the other runtime can offer it. */
  models: () => ModelSuggestion[]
}

export const SPAWN_RUNTIMES = [
  {
    kind: "claude",
    label: "Claude Code",
    binary: "claude",
    binEnv: "THREA_HARNESSD_CLAUDE_BIN",
    // The TUI's `/effort` also offers `ultracode`, which has no launch flag: a
    // spawn naming it would silently boot on the default effort instead.
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    models: claudeModelSuggestions,
  },
  {
    kind: "pi",
    label: "Pi",
    binary: "pi",
    binEnv: "THREA_HARNESSD_PI_BIN",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    models: piModelSuggestions,
  },
] as const satisfies readonly SpawnRuntimeDefinition[]

export type RuntimeKind = (typeof SPAWN_RUNTIMES)[number]["kind"]

export function isRuntimeKind(value: string | undefined): value is RuntimeKind {
  return SPAWN_RUNTIMES.some((runtime) => runtime.kind === value)
}

export function runtimeDefinition(kind: RuntimeKind): SpawnRuntimeDefinition {
  const found = SPAWN_RUNTIMES.find((runtime) => runtime.kind === kind)
  if (!found) die(`unknown runtime kind: ${kind}`)
  return found
}

export interface ResolveRuntimeBinaryDeps {
  env: NodeJS.ProcessEnv
  lookup: (bin: string) => string | undefined
}

export function resolveRuntimeBinary(
  runtime: SpawnRuntimeDefinition,
  deps: ResolveRuntimeBinaryDeps = { env: process.env, lookup: commandPath }
): string | undefined {
  return deps.env[runtime.binEnv] || deps.lookup(runtime.binary)
}

export function requireRuntimeBinary(runtime: SpawnRuntimeDefinition, deps?: ResolveRuntimeBinaryDeps): string {
  const bin = resolveRuntimeBinary(runtime, deps)
  if (!bin) die(`${runtime.binary} binary not found; set ${runtime.binEnv} or put ${runtime.binary} on PATH`)
  return bin
}

export interface SpawnRuntimeOption {
  value: RuntimeKind
  label: string
  installed: boolean
  thinkingLevels: string[]
  /** Empty until the runtime is installed: an absent binary has no catalog worth offering. */
  models: ModelSuggestion[]
  description?: string
}

export function spawnRuntimeCatalog(deps?: ResolveRuntimeBinaryDeps): SpawnRuntimeOption[] {
  return SPAWN_RUNTIMES.map((runtime) => {
    const binary = resolveRuntimeBinary(runtime, deps)
    const option = { value: runtime.kind, label: runtime.label, thinkingLevels: [...runtime.thinkingLevels] }
    return binary
      ? { ...option, installed: true, models: runtime.models(), description: binary }
      : { ...option, installed: false, models: [] }
  })
}
