export interface SandboxFile {
  /** Absolute path inside the sandbox. */
  path: string
  data: Uint8Array
}

/** Lets the command call Threa's public API as the agent's turn, through the broker in the box. */
export interface SandboxApiAccess {
  /** Stays with the runner and the broker; the command never sees it. */
  token: string
  workspaceId: string
}

export interface SandboxExecOptions {
  timeoutSec: number
  maxOutputBytes: number
  signal?: AbortSignal
  api?: SandboxApiAccess
}

export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** Output past the cap was dropped. */
  truncated: boolean
}

/** Where sandboxes live. The runner owns the boxes; `stream_sandboxes` only records which one is current. */
export interface SandboxRunner {
  /** Stored with each sandbox, so a box made by a different runner is never reused. */
  readonly kind: string
  create(params: { internet: boolean; workspaceId: string; streamId: string }): Promise<string>
  /** Also counts as use, so a box checked here is not reaped before the command that follows. */
  alive(sandboxId: string): Promise<boolean>
  writeFiles(sandboxId: string, files: SandboxFile[]): Promise<void>
  /** One command at a time per box: each exec kills whatever the last one left running. */
  exec(sandboxId: string, command: string, options: SandboxExecOptions): Promise<SandboxExecResult>
  destroy(sandboxId: string): Promise<void>
}
