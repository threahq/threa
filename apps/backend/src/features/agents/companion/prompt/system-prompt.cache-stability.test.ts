import { describe, expect, test } from "bun:test"
import { DEFAULT_USER_PREFERENCES, StreamTypes, type UserPreferences } from "@threa/types"
import type { Persona } from "../../persona-repository"
import type { StreamContext } from "../../context-builder"
import { buildSystemPrompt, SYSTEM_PROMPT_INPUT_STABILITY, type SystemPromptInputs } from "./system-prompt"

/**
 * The structural guard for the prompt's cache split.
 *
 * Per-turn content leaking into the cached half has shipped four times, and
 * every time it was invisible: the prompt is still correct, every test still
 * passes, and the only symptom is a cache hit rate that never materialises.
 * Each previous fix added an assertion for the specific section that leaked,
 * which is why the next one was missed too.
 *
 * This test is driven by `SYSTEM_PROMPT_INPUT_STABILITY` instead. Because that
 * table is `Record<keyof SystemPromptInputs, …>`, a new input cannot be added
 * without classifying it, and every input classified `turn` is proven here to
 * stay out of the cached half. The failure mode is a build error or a failing
 * test, not a silent cost regression.
 */

const SENTINEL = "__PER_TURN_SENTINEL__"

const persona: Persona = {
  id: "persona_ariadne",
  workspaceId: null,
  slug: "ariadne",
  name: "Ariadne",
  description: null,
  avatarEmoji: null,
  avatarUrl: null,
  systemPrompt: "Base system prompt",
  model: "openai/gpt-5.4",
  escalationModel: null,
  temperature: 0.2,
  maxTokens: 1000,
  enabledTools: null,
  tonePreset: null,
  brevityPreset: null,
  tonePrompt: null,
  brevityPrompt: null,
  managedBy: "system",
  ownerUserId: null,
  status: "active",
  visibility: "visible",
  e2eCapable: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} as Persona

const context: StreamContext = {
  streamType: StreamTypes.SCRATCHPAD,
  streamInfo: { id: "stream_test", name: "Ideas", description: null, slug: null },
  conversationHistory: [],
  temporal: {
    currentTime: "2026-07-03T09:00:00.000Z",
    timezone: "UTC",
    utcOffset: "UTC+0",
    dateFormat: "YYYY-MM-DD",
    timeFormat: "24h",
  },
} as unknown as StreamContext

const BASE_PREFERENCES: UserPreferences = {
  ...DEFAULT_USER_PREFERENCES,
  workspaceId: "ws_test",
  userId: "usr_test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

const BASE: SystemPromptInputs = { persona, context }

/**
 * A value carrying the sentinel, shaped for each per-turn input. Keyed by input
 * name so a newly-classified `turn` input fails here until it is given one —
 * the table alone cannot know what a valid value looks like.
 */
const PER_TURN_SENTINEL_VALUES: Record<string, Partial<SystemPromptInputs>> = {
  purpose: { purpose: { kind: "mention" }, mentionerName: SENTINEL },
  mentionerName: { purpose: { kind: "mention" }, mentionerName: SENTINEL },
  rollingConversationSummary: { rollingConversationSummary: SENTINEL },
  conversationTopic: { conversationTopic: SENTINEL },
  spawnedFromContext: { spawnedFromContext: SENTINEL },
  previousSessions: { previousSessions: SENTINEL },
  currentSettings: {
    currentSettings: {
      ...DEFAULT_USER_PREFERENCES,
      workspaceId: "ws_test",
      userId: "usr_test",
      timezone: SENTINEL,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies UserPreferences,
  },
  followUp: {
    purpose: { kind: "follow_up", followUpId: "fup_1" },
    followUp: { note: SENTINEL, scheduledFor: new Date("2026-07-04T09:00:00.000Z") },
  },
  subagentBrief: {
    purpose: { kind: "subagent_kickoff", subagentRunId: "subagent_1" },
    subagentBrief: { title: SENTINEL },
  },
}

describe("system prompt cache stability", () => {
  const perTurnInputs = Object.entries(SYSTEM_PROMPT_INPUT_STABILITY)
    .filter(([, stability]) => stability === "turn")
    .map(([name]) => name)

  test("every per-turn input has a sentinel case, so none can be silently skipped", () => {
    expect(perTurnInputs.sort()).toEqual(Object.keys(PER_TURN_SENTINEL_VALUES).sort())
  })

  for (const name of perTurnInputs) {
    test(`\`${name}\` never reaches the cached half`, () => {
      const overrides = PER_TURN_SENTINEL_VALUES[name]
      expect(overrides).toBeDefined()

      const built = buildSystemPrompt({ ...BASE, ...overrides })

      // Present somewhere — otherwise the assertion below passes vacuously and
      // the guard silently stops guarding.
      expect(built.stable + built.volatile).toContain(SENTINEL)
      expect(built.stable).not.toContain(SENTINEL)
    })
  }

  // `context` is the one `mixed` input: stream metadata is conversation-scoped,
  // `context.temporal` is per-turn. Asserted directly since the table cannot
  // express a per-field split.
  test("temporal grounding inside `context` never reaches the cached half", () => {
    const built = buildSystemPrompt(BASE)

    expect(built.stable).not.toContain("## Current Time")
    expect(built.volatile).toContain("## Current Time")
  })

  test("stream metadata inside `context` stays in the cached half", () => {
    const built = buildSystemPrompt(BASE)

    expect(built.stable).toContain("Ideas")
  })

  // The property every per-turn classification exists to protect: two turns of
  // the same conversation must produce a byte-identical cached half.
  test("the cached half is byte-identical across two fully-different turns", () => {
    const turnOne = buildSystemPrompt({
      ...BASE,
      purpose: { kind: "mention" },
      mentionerName: "Kris",
      conversationTopic: "topic one",
      rollingConversationSummary: "summary one",
      spawnedFromContext: "parent one",
      previousSessions: "## Previous Sessions\n\nsession one",
      currentSettings: { ...BASE_PREFERENCES, timezone: "Europe/Stockholm" },
    })
    const turnTwo = buildSystemPrompt({
      ...BASE,
      purpose: { kind: "catch_up" },
      mentionerName: "Sam",
      conversationTopic: "topic two",
      rollingConversationSummary: "summary two",
      spawnedFromContext: "parent two",
      previousSessions: "## Previous Sessions\n\nsession two",
      currentSettings: { ...BASE_PREFERENCES, timezone: "America/New_York" },
    })

    expect(turnOne.stable).toBe(turnTwo.stable)
  })
})
