export type RuntimeKind = "pi" | "claude"
export type AgentStatus = "starting" | "online" | "offline" | "stopped" | "error"

export interface ManagedAgent {
  id: string
  name: string
  runtime: RuntimeKind
  status: AgentStatus
  worktree?: string
  branch?: string
  tmuxSession?: string
  tmuxWindow?: string
  /** Stable tmux window id (`@n`) — the durable target for steer/keys/stop; names can collide or be renamed. */
  tmuxWindowId?: string
  scratchpadUrl?: string
  command: string[]
  createdAt: string
  updatedAt: string
  lastOutput?: string
}

export interface SpawnOptions {
  runtime: RuntimeKind
  name: string
  branch?: string
  base?: string
  repo?: string
  tmux?: string
  skipSetup?: boolean
  noRemote?: boolean
  noRegister?: boolean
  noAutoAccept?: boolean
  noYolo?: boolean
}

export interface ResumeOptions {
  tmux?: string
  dryRun?: boolean
  force?: boolean
}

export interface SpawnResult {
  worktree: string
  branch: string
  tmuxSession: string
  tmuxWindow: string
  tmuxWindowId: string
  scratchpadUrl?: string
  output: string
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ThreaChannelConfig {
  baseUrl?: string
  workspaceId?: string
  apiKey?: string
  displayName?: string
  defaultLabel?: string
  instanceId?: string
  runtimeSessionId?: string
}
