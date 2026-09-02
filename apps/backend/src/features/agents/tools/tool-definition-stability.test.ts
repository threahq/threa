import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { MUTATING_TOOL_NAMES } from "@threa/types"
import { buildToolSet } from "../companion/tool-set"

/**
 * Tool definitions must be byte-identical across requests.
 *
 * They render AHEAD of the system prompt in the prompt-cache prefix, so a
 * per-request value baked into any tool's `description`, `promptBlock`, or
 * schema changes the prefix on every call — taking the hit rate for the ENTIRE
 * toolset to zero, not just that tool's share. This has happened: `web_search`
 * interpolated the live invocation timestamp into its description, which would
 * have made prompt caching look like it simply does not work on this stack.
 *
 * The companion guard (`system-prompt.cache-stability.test.ts`) covers inputs to
 * the system prompt; this covers the region before it. Both are needed — they
 * sit on opposite sides of the same cached span.
 *
 * Scope, stated plainly: this varies the per-request values the tool set is
 * actually constructed with today. A tool that interpolated some *other*
 * per-request value would slip past, because the test cannot vary an input it
 * does not know about. That residual gap is syntactic rather than behavioural —
 * see the note in the PR about where a lint rule earns its place.
 */

const stub: any = new Proxy(() => stub, { get: () => stub, apply: () => stub })

/**
 * `start_subagent` names the workspace's governed set in its description, so
 * it needs a real array rather than the proxy. Per-workspace, not per-request:
 * a workspace's set is stable across calls, which is what the cached prefix
 * requires.
 */
const subagentDelegation = { allowedModels: ["openrouter:openai/gpt-5.6-terra"], delegateToModel: stub }

/** Serialize a tool set to exactly what the model would see. */
function definitions(over: { currentTime: string; timezone: string; briefVersion: number }) {
  const tools = buildToolSet({
    enabledTools: null,
    tavilyApiKey: "test-key",
    currentTime: over.currentTime,
    timezone: over.timezone,
    briefVersion: over.briefVersion,
    runWorkspaceAgent: stub,
    runGeneralResearch: stub,
    workspace: stub,
    reactions: stub,
    followUps: stub,
    brief: stub,
    delegation: stub,
    subagentDelegation,
    reportBack: stub,
    saveMemo: stub,
    github: stub,
    linear: stub,
    supportsVision: true,
  })

  return new Map(
    tools.map((t) => [
      t.name,
      JSON.stringify({
        description: t.config.description,
        promptBlock: t.config.promptBlock ?? null,
        schema: z.toJSONSchema(t.config.inputSchema as never, { io: "input" }),
      }),
    ])
  )
}

describe("tool definition cache stability", () => {
  const a = definitions({ currentTime: "2026-07-26T10:00:00.000Z", timezone: "Europe/Stockholm", briefVersion: 3 })
  const b = definitions({ currentTime: "2026-07-26T10:00:31.000Z", timezone: "America/New_York", briefVersion: 4 })

  test("builds a non-empty tool set, so the comparison below cannot pass vacuously", () => {
    expect(a.size).toBeGreaterThan(20)
    expect([...a.keys()]).toEqual([...b.keys()])
  })

  for (const name of [...new Set([...a.keys()])]) {
    test(`\`${name}\` is byte-identical across differing per-request values`, () => {
      expect(a.get(name)).toBe(b.get(name))
    })
  }
})

/**
 * Layer-0 ratchet. A mutating tool with no `trace.effects` still gets an effect
 * — one shapeless `other` descriptor — so the regression is invisible at
 * runtime: the card keeps saying "wrote something" and stops saying what.
 */
describe("mutating tools declare their own effects", () => {
  const built = new Map(
    buildToolSet({
      enabledTools: null,
      tavilyApiKey: "test-key",
      currentTime: "2026-07-26T10:00:00.000Z",
      timezone: "Europe/Stockholm",
      briefVersion: 1,
      runWorkspaceAgent: stub,
      runGeneralResearch: stub,
      workspace: stub,
      reactions: stub,
      followUps: stub,
      brief: stub,
      delegation: stub,
      subagentDelegation,
      reportBack: stub,
      saveMemo: stub,
      settings: stub,
      github: stub,
      linear: stub,
      supportsVision: true,
    }).map((t) => [t.name, t])
  )

  test("every mutating tool this build constructs is present, so the loop can't pass vacuously", () => {
    expect(MUTATING_TOOL_NAMES.filter((name) => built.has(name))).toEqual([...MUTATING_TOOL_NAMES])
  })

  for (const name of MUTATING_TOOL_NAMES) {
    test(`\`${name}\` declares effects rather than falling back to layer 0`, () => {
      expect(typeof built.get(name)?.config.trace.effects).toBe("function")
    })
  }
})
