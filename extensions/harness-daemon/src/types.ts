import type { RuntimeKind } from "./runtimes"

export type { RuntimeKind }
export type ScratchpadStatus = "active" | "archived" | "inaccessible" | "unavailable"
/** The two verdicts that outlive a pass, so a row carrying one is backed off rather than re-probed. */
export type ProbeVerdict = Extract<ScratchpadStatus, "archived" | "inaccessible">
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
  /** Thread the link points at when the session was attached; `scratchpadUrl` stays the root, which is what revival probes. */
  activeStreamId?: string
  command: string[]
  createdAt: string
  updatedAt: string
  lastOutput?: string
  /** Consecutive probes that came back with a verdict; resets the moment the scratchpad is live again. */
  probeFailures?: number
  /** ISO instant before which the revival probe is suppressed for this row. */
  probeBackoffUntil?: string
  /**
   * What the last probe found, present exactly while `probeBackoffUntil` is.
   * The revive sweep probes first and the tombstone pass runs after it, so
   * without the recorded verdict the later pass has to re-ask the very
   * scratchpad the backoff exists to stop asking about.
   */
  probeVerdict?: ProbeVerdict
  /**
   * ISO instant at which this row stopped being a revival candidate: its worktree
   * is gone AND its scratchpad is archived. History, never deleted.
   */
  tombstonedAt?: string
  /**
   * ISO instant an operator explicitly requested a fresh restart that has not
   * happened yet. Set only by the `clear` command; the next successful revival
   * honors it (fresh start) and clears it. Never set by any automatic path —
   * revival acting on it is completing a recorded user request, not auto-clearing.
   */
  clearPendingAt?: string
}

/** What a runtime starts on, as the spawn named it: `claude --model/--effort`, `pi --model/--thinking`. */
export interface RuntimeModelChoice {
  model?: string
  thinking?: string
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
  /** Passed to the runtime at launch: `claude --model`, `pi --model` (a `provider/id` pattern is fine). */
  model?: string
  /** Passed to the runtime at launch, actuated as `claude --effort` / `pi --thinking`. */
  thinking?: string
  tmux?: string
  skipSetup?: boolean
  noRemote?: boolean
  noRegister?: boolean
  noAutoAccept?: boolean
  noYolo?: boolean
  /** Link the session to a thread under an existing scratchpad instead of minting a new one. */
  attach?: { rootStreamId: string; anchorId: string }
  /** Path to a file whose content is delivered as a brief once the attached session is up. Requires `attach`. */
  briefFile?: string
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
  /** Evaluate only these inventory rows: the watcher's vanished-pane sweep names the rows it saw die. */
  agentIds?: ReadonlySet<string>
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
  activeStreamId?: string
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
