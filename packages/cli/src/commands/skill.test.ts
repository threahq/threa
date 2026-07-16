import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../cli"

test("skill install copies SKILL.md into the target skills dir", async () => {
  const target = mkdtempSync(join(tmpdir(), "threa-skills-"))
  try {
    const result = await run(["skill", "install", "--target", target, "--json"])
    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as { destination: string; installed: boolean }
    expect(payload.installed).toBe(true)
    const written = readFileSync(join(target, "threa-cli", "SKILL.md"), "utf8")
    expect(written).toContain("name: threa-cli")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("skill without install subcommand is a usage error", async () => {
  const result = await run(["skill", "banana"])
  expect(result.exitCode).toBe(2)
  expect(JSON.parse(result.stderr).code).toBe("USAGE")
})
