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
  /** Stable tmux window id (`@n`) for window lifecycle; names can collide or be renamed. */
  tmuxWindowId?: string
  /** Stable tmux pane id (`%n`) for key injection; avoids whichever split is active in the window. */
  tmuxPaneId?: string
  scratchpadUrl?: string
  instanceId?: string
  runtimeSessionId?: string
  command: string[]
  createdAt: string
  updatedAt: string
  lastOutput?: string
  /** Consecutive 403/404 probes; resets the moment the scratchpad answers. */
  probeFailures?: number
  /** ISO instant before which the revival probe is suppressed for this row. */
  probeBackoffUntil?: string
  /**
   * ISO instant at which this row stopped being a revival candidate: its worktree
   * is gone AND its scratchpad is archived. History, never deleted.
   */
  tombstonedAt?: string
}

export interface SpawnOptions {
  runtime: RuntimeKind
  name: string
  branch?: string
  base?: string
  repo?: string
  /** Use this directory as-is; provisions nothing, and cleanup may reclaim nothing. */
  cwd?: string
  /** Name of a profile in the profiles file; missing names die rather than falling back. */
  profile?: string
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
  recreateWorktree?: boolean
  /**
   * Opt-in for the unattended watcher only: it re-sweeps every row every 60s, so a
   * durably 403/404 scratchpad must not be re-probed each pass. An explicit CLI run
   * always probes live, because live state is what decides revival.
   */
  respectProbeBackoff?: boolean
  /**
   * Start a fresh conversation instead of resuming history. Set ONLY by the
   * `clear` command — a user's explicit request. No revival path may set it.
   */
  fresh?: boolean
}

export interface SpawnResult {
  worktree: string
  branch: string
  tmuxSession: string
  tmuxWindow: string
  tmuxWindowId: string
  tmuxPaneId: string
  scratchpadUrl?: string
  instanceId?: string
  runtimeSessionId?: string
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
