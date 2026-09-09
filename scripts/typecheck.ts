import { spawn } from "child_process"
import * as path from "path"
import { runUnderHeavyLock } from "./lib/heavy-lock"

const rootDir = path.resolve(import.meta.dir, "..")

const allPackages = [
  "packages/types",
  "packages/prosemirror",
  "packages/crypto",
  "packages/backend-common",
  "packages/agent-runtime",
  "packages/cli",
  "apps/backend",
  "apps/control-plane",
  "apps/workspace-router",
  "apps/backoffice-router",
  "apps/frontend",
  "apps/backoffice",
  "apps/db-read-proxy",
  "apps/enclave",
  "apps/public-site",
  "typecheck:monitor",
]

function usage(): void {
  console.error(
    "Usage: bun scripts/typecheck.ts <package...> [--all]\n" +
      "  bun run typecheck apps/backend packages/types   typecheck those packages, in order\n" +
      "  bun run typecheck --all                         typecheck every workspace, under the heavy lock"
  )
}

function run(command: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, stdio: "inherit" })
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

async function runChain(packages: string[]): Promise<number> {
  for (const pkg of packages) {
    const command =
      pkg === "typecheck:monitor" ? ["bun", "run", "typecheck:monitor"] : ["bun", "run", "--cwd", pkg, "typecheck"]
    const code = await run(command, rootDir)
    if (code !== 0) return code
  }
  return 0
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const all = args.includes("--all")
  const packages = args.filter((arg) => arg !== "--all")

  if (packages.length === 0 && !all && !process.env.CI) {
    console.error(
      "Refusing to run the full typecheck locally. Pass file paths or patterns to target your change, or --all to run everything. CI runs the full suite on push."
    )
    return 1
  }

  if (packages.length > 0) return await runChain(packages)

  return await runUnderHeavyLock(["bun", "scripts/typecheck.ts", ...allPackages], {
    cwd: rootDir,
    label: "typecheck --all",
  })
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  usage()
  process.exitCode = 0
} else {
  void main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error("Typecheck runner failed:")
      console.error(error)
      process.exitCode = 1
    })
}
