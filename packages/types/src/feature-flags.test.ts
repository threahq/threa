import { describe, test, expect } from "bun:test"
import {
  defaultFeatureFlags,
  isFeatureFlagKey,
  registryAllowsScope,
  resolveAgainstRegistry,
  resolveFeatureFlags,
  type FeatureFlagRegistry,
} from "./feature-flags"

/** Stand-in for a registry mid-rollout; the shipped one is empty between rollouts. */
const registry = {
  wsOnly: { values: ["off", "on"], scopes: ["workspace"] },
  userOnly: { values: ["off", "on"], scopes: ["user"] },
  both: { values: ["off", "shadow", "active"], scopes: ["workspace", "user"] },
} as const satisfies FeatureFlagRegistry

/**
 * Overrides as they actually arrive — parsed from a wire body, where `__proto__`
 * IS an own property. An object literal would instead set the prototype and test nothing.
 */
function polluted(): Record<string, string> {
  return JSON.parse('{"__proto__":"active","constructor":"active","toString":"active","hasOwnProperty":"active"}')
}

describe("resolveAgainstRegistry", () => {
  test("every flag falls back to its first declared value", () => {
    expect(resolveAgainstRegistry(registry, { workspace: {}, user: {} })).toEqual({
      wsOnly: "off",
      userOnly: "off",
      both: "off",
    })
  })

  test("workspace override applies to a flag declaring workspace scope", () => {
    expect(resolveAgainstRegistry(registry, { workspace: { wsOnly: "on", both: "shadow" }, user: {} })).toEqual({
      wsOnly: "on",
      userOnly: "off",
      both: "shadow",
    })
  })

  test("user override beats a workspace override for the same key", () => {
    expect(resolveAgainstRegistry(registry, { workspace: { both: "shadow" }, user: { both: "active" } })).toEqual({
      wsOnly: "off",
      userOnly: "off",
      both: "active",
    })
  })

  test("workspace override is inert for a user-only flag", () => {
    expect(resolveAgainstRegistry(registry, { workspace: { userOnly: "on" }, user: {} })).toEqual({
      wsOnly: "off",
      userOnly: "off",
      both: "off",
    })
  })

  test("user override is inert for a workspace-only flag", () => {
    expect(resolveAgainstRegistry(registry, { workspace: {}, user: { wsOnly: "on" } })).toEqual({
      wsOnly: "off",
      userOnly: "off",
      both: "off",
    })
  })

  test("overrides for retired keys and undeclared values are dropped", () => {
    expect(
      resolveAgainstRegistry(registry, {
        workspace: { retired: "on", wsOnly: "maybe" },
        user: { userOnly: "enabled" },
      })
    ).toEqual({ wsOnly: "off", userOnly: "off", both: "off" })
  })

  test("a user override still applies when the workspace layer dropped its own", () => {
    expect(resolveAgainstRegistry(registry, { workspace: { both: "bogus" }, user: { both: "active" } })).toEqual({
      wsOnly: "off",
      userOnly: "off",
      both: "active",
    })
  })
})

describe("registryAllowsScope", () => {
  test("reports the scopes each flag declares", () => {
    const declared = (key: string) => ({
      workspace: registryAllowsScope(registry, key, "workspace"),
      user: registryAllowsScope(registry, key, "user"),
    })
    expect({ wsOnly: declared("wsOnly"), userOnly: declared("userOnly"), both: declared("both") }).toEqual({
      wsOnly: { workspace: true, user: false },
      userOnly: { workspace: false, user: true },
      both: { workspace: true, user: true },
    })
  })

  test("an unregistered key allows no scope", () => {
    expect({
      workspace: registryAllowsScope(registry, "retired", "workspace"),
      user: registryAllowsScope(registry, "retired", "user"),
    }).toEqual({ workspace: false, user: false })
  })
})

describe("resolveFeatureFlags", () => {
  test("resolves against the shipped registry and ignores unregistered overrides", () => {
    expect(resolveFeatureFlags({ workspace: { retired: "on" }, user: { retired: "on" } })).toEqual(
      defaultFeatureFlags()
    )
  })

  test("prototype-chain keys never resolve as flags", () => {
    expect(resolveFeatureFlags({ workspace: polluted(), user: polluted() })).toEqual(defaultFeatureFlags())
  })
})

describe("prototype-chain keys", () => {
  test("are dropped from both layers rather than throwing", () => {
    expect(resolveAgainstRegistry(registry, { workspace: polluted(), user: polluted() })).toEqual({
      wsOnly: "off",
      userOnly: "off",
      both: "off",
    })
  })

  test("allow no scope", () => {
    expect({
      proto: registryAllowsScope(registry, "__proto__", "workspace"),
      constructor: registryAllowsScope(registry, "constructor", "user"),
      toString: registryAllowsScope(registry, "toString", "workspace"),
    }).toEqual({ proto: false, constructor: false, toString: false })
  })

  test("are rejected by isFeatureFlagKey, so the write path 400s instead of throwing", () => {
    expect({
      constructor: isFeatureFlagKey("constructor"),
      toString: isFeatureFlagKey("toString"),
      hasOwnProperty: isFeatureFlagKey("hasOwnProperty"),
    }).toEqual({ constructor: false, toString: false, hasOwnProperty: false })
  })
})
