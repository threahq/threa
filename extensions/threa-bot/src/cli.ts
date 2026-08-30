import { createRequire } from "node:module"
import { parseCliArgs, USAGE } from "./args"
import { runMentions, runScratchpad } from "./run"

const log = (line: string) => process.stderr.write(`[threa-bot] ${line}\n`)

export async function main(argv: readonly string[]): Promise<number> {
  if (process.platform === "win32") {
    // Stop, steer, timeout and shutdown kill the agent's process group with
    // POSIX signals; without that the command would outlive every one of them.
    process.stderr.write("threa-bot runs on macOS and Linux; Windows is not supported yet.\n")
    return 1
  }
  let args
  try {
    args = parseCliArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`)
    return 2
  }
  if (args.kind === "help") {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.kind === "version") {
    // Beside this file in the published layout (dist/cli.js + dist/package.json), one up in the repo.
    const require = createRequire(import.meta.url)
    let pkg: { version: string }
    try {
      pkg = require("./package.json")
    } catch {
      pkg = require("../package.json")
    }
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  const deps = { env: process.env, cwd: process.cwd(), log }
  try {
    if (args.mode === "mention") await runMentions(args, deps)
    else await runScratchpad(args, deps)
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
    return 1
  }
  // A started runtime keeps the process alive through its timers and socket;
  // returning here only means start-up finished.
  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  if (code !== 0) process.exit(code)
}
