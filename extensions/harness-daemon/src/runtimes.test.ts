import { expect, test } from "bun:test"
import { installedSpawnRuntimes } from "./runtimes"

test("should list both runtimes with their resolved paths when both binaries are on PATH", () => {
  const lookup = (bin: string): string | undefined => `/usr/local/bin/${bin}`
  expect(installedSpawnRuntimes({ env: {}, lookup })).toEqual([
    { value: "claude", label: "Claude Code", description: "/usr/local/bin/claude" },
    { value: "pi", label: "Pi", description: "/usr/local/bin/pi" },
  ])
})

test("should prefer the env override path over PATH lookup when the override is set", () => {
  const lookup = (bin: string): string | undefined => `/usr/local/bin/${bin}`
  const env = { THREA_HARNESSD_CLAUDE_BIN: "/opt/custom/claude" }
  expect(installedSpawnRuntimes({ env, lookup })).toEqual([
    { value: "claude", label: "Claude Code", description: "/opt/custom/claude" },
    { value: "pi", label: "Pi", description: "/usr/local/bin/pi" },
  ])
})

test("should omit a runtime whose binary is missing", () => {
  const lookup = (bin: string): string | undefined => (bin === "pi" ? "/usr/local/bin/pi" : undefined)
  expect(installedSpawnRuntimes({ env: {}, lookup })).toEqual([
    { value: "pi", label: "Pi", description: "/usr/local/bin/pi" },
  ])
})

test("should return an empty list when nothing is installed", () => {
  const lookup = (): string | undefined => undefined
  expect(installedSpawnRuntimes({ env: {}, lookup })).toEqual([])
})
