import { die } from "./errors"
import type { RunResult } from "./types"

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function commandExists(name: string): boolean {
  const result = Bun.spawnSync(["bash", "-lc", `command -v ${name} >/dev/null`])
  return result.exitCode === 0
}

export function commandPath(name: string): string | undefined {
  const result = Bun.spawnSync(["bash", "-lc", `command -v ${name}`], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) return undefined
  return result.stdout.toString().trim() || undefined
}

export function run(command: string[], options: { cwd?: string; allowFailure?: boolean } = {}): RunResult {
  const result = Bun.spawnSync(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  if (result.exitCode !== 0 && !options.allowFailure) {
    die(`${command.join(" ")} failed with exit code ${result.exitCode}`)
  }
  return { stdout, stderr, exitCode: result.exitCode }
}

export function output(command: string[], options: { cwd?: string; allowFailure?: boolean } = {}): RunResult {
  const result = Bun.spawnSync(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0 && !options.allowFailure) {
    die(stderr.trim() || `${command.join(" ")} failed with exit code ${result.exitCode}`)
  }
  return { stdout, stderr, exitCode: result.exitCode }
}
