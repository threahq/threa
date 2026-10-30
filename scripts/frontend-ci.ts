import { spawnSync } from "node:child_process"

const sources = JSON.parse(process.env.FRONTEND_SOURCES ?? "null") as unknown
const tests = JSON.parse(process.env.FRONTEND_TESTS ?? "null") as unknown
if (
  !Array.isArray(sources) ||
  !Array.isArray(tests) ||
  [...sources, ...tests].some((file) => typeof file !== "string" || !file.startsWith("apps/frontend/src/"))
) {
  throw new Error("invalid frontend CI selection")
}
if (!sources.length && !tests.length) throw new Error("empty frontend CI selection")

const files = [...new Set([...sources, ...tests])].map((file) => file.slice("apps/frontend/".length))
const result = spawnSync("bunx", ["vitest", "related", "--run", "--maxWorkers=1", ...files], {
  cwd: "apps/frontend",
  stdio: "inherit",
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
