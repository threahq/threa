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

export function requireRuntimeBinary(runtime: SpawnRuntimeDefinition): string {
  const bin = resolveRuntimeBinary(runtime)
  if (!bin) die(`${runtime.binary} binary not found; set ${runtime.binEnv} or put ${runtime.binary} on PATH`)
  return bin
}

export interface InstalledSpawnRuntime {
  value: RuntimeKind
  label: string
  description: string
}

export function installedSpawnRuntimes(deps?: ResolveRuntimeBinaryDeps): InstalledSpawnRuntime[] {
  const installed: InstalledSpawnRuntime[] = []
  for (const runtime of SPAWN_RUNTIMES) {
    const binary = resolveRuntimeBinary(runtime, deps)
    if (binary) installed.push({ value: runtime.kind, label: runtime.label, description: binary })
  }
  return installed
}
