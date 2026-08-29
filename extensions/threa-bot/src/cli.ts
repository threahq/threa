import { createRequire } from "node:module"
import { parseCliArgs, USAGE } from "./args"
import { runMentions, runScratchpad } from "./run"

const log = (line: string) => process.stderr.write(`[threa-bot] ${line}\n`)

export async function main(argv: readonly string[]): Promise<number> {
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
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string }
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
