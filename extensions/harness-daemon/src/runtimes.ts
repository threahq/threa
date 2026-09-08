import { die } from "./errors"
import { commandPath } from "./shell"

export interface SpawnRuntimeDefinition {
  kind: string
  label: string
  binary: string
  binEnv: string
}

export const SPAWN_RUNTIMES = [
  { kind: "claude", label: "Claude Code", binary: "claude", binEnv: "THREA_HARNESSD_CLAUDE_BIN" },
  { kind: "pi", label: "Pi", binary: "pi", binEnv: "THREA_HARNESSD_PI_BIN" },
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
  description?: string
}

export function spawnRuntimeCatalog(deps?: ResolveRuntimeBinaryDeps): SpawnRuntimeOption[] {
  return SPAWN_RUNTIMES.map((runtime) => {
    const binary = resolveRuntimeBinary(runtime, deps)
    return binary
      ? { value: runtime.kind, label: runtime.label, installed: true, description: binary }
      : { value: runtime.kind, label: runtime.label, installed: false }
  })
}
