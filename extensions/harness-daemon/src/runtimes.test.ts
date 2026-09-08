import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeModelSuggestions } from "@threahq/harness-client"
import { requireRuntimeBinary, runtimeDefinition, spawnRuntimeCatalog } from "./runtimes"

test("should list both runtimes as installed with their resolved paths when both binaries are on PATH", () => {
  const lookup = (bin: string): string | undefined => `/usr/local/bin/${bin}`
  expect(spawnRuntimeCatalog({ env: {}, lookup })).toEqual([
    {
      value: "claude",
      label: "Claude Code",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      installed: true,
      models: expect.any(Array),
      description: "/usr/local/bin/claude",
    },
    {
      value: "pi",
      label: "Pi",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      installed: true,
      models: expect.any(Array),
      description: "/usr/local/bin/pi",
    },
  ])
})

test("should prefer the env override path over PATH lookup when the override is set", () => {
  const lookup = (bin: string): string | undefined => `/usr/local/bin/${bin}`
  const env = { THREA_HARNESSD_CLAUDE_BIN: "/opt/custom/claude" }
  expect(spawnRuntimeCatalog({ env, lookup })).toEqual([
    {
      value: "claude",
      label: "Claude Code",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      installed: true,
      models: expect.any(Array),
      description: "/opt/custom/claude",
    },
    {
      value: "pi",
      label: "Pi",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      installed: true,
      models: expect.any(Array),
      description: "/usr/local/bin/pi",
    },
  ])
})

test("should keep a runtime whose binary is missing in the catalog as not installed", () => {
  const lookup = (bin: string): string | undefined => (bin === "pi" ? "/usr/local/bin/pi" : undefined)
  expect(spawnRuntimeCatalog({ env: {}, lookup })).toEqual([
    {
      value: "claude",
      label: "Claude Code",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      installed: false,
      models: [],
    },
    {
      value: "pi",
      label: "Pi",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      installed: true,
      models: expect.any(Array),
      description: "/usr/local/bin/pi",
    },
  ])
})

test("should mark every runtime as not installed when nothing is on PATH", () => {
  const lookup = (): string | undefined => undefined
  expect(spawnRuntimeCatalog({ env: {}, lookup })).toEqual([
    {
      value: "claude",
      label: "Claude Code",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      installed: false,
      models: [],
    },
    {
      value: "pi",
      label: "Pi",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      installed: false,
      models: [],
    },
  ])
})

test("should name the env override and the binary when a required runtime is missing", () => {
  const lookup = (): string | undefined => undefined
  expect(() => requireRuntimeBinary(runtimeDefinition("pi"), { env: {}, lookup })).toThrow(
    "pi binary not found; set THREA_HARNESSD_PI_BIN or put pi on PATH"
  )
})

test("should print the catalog as JSON from the runtimes subcommand, each runtime carrying its own models", () => {
  const home = mkdtempSync(join(tmpdir(), "runtimes-home-"))
  writeFileSync(join(home, ".claude.json"), JSON.stringify({}))
  mkdirSync(join(home, ".pi", "agent"), { recursive: true })
  writeFileSync(
    join(home, ".pi", "agent", "models-store.json"),
    JSON.stringify({ "opencode-go": { models: [{ id: "kimi-k3", name: "Kimi K3", input: ["text", "image"] }] } })
  )
  const result = Bun.spawnSync(["bun", new URL("./index.ts", import.meta.url).pathname, "runtimes"], {
    env: {
      ...process.env,
      HOME: home,
      THREA_HARNESSD_CLAUDE_BIN: "/opt/claude",
      THREA_HARNESSD_PI_BIN: "/opt/pi",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual([
    {
      value: "claude",
      label: "Claude Code",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      installed: true,
      models: claudeModelSuggestions(join(home, ".claude.json")),
      description: "/opt/claude",
    },
    {
      value: "pi",
      label: "Pi",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      installed: true,
      models: [{ value: "opencode-go/kimi-k3", label: "Kimi K3" }],
      description: "/opt/pi",
    },
  ])
})
