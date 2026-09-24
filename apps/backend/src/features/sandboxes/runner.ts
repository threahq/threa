export interface SandboxFile {
  /** Absolute path inside the sandbox. */
  path: string
  data: Uint8Array
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
  exec(
    sandboxId: string,
    command: string,
    options: { timeoutSec: number; maxOutputBytes: number; signal?: AbortSignal }
  ): Promise<SandboxExecResult>
  destroy(sandboxId: string): Promise<void>
}
