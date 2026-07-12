/**
 * Persona-Style Test Cases (roadmap 7.1)
 *
 * Two axes, one shared message per axis so the effect isolates to the slot:
 *  - tone: warm / neutral / direct over a message with emotional valence, where
 *    the difference in *how it's said* is the whole point (brevity left default).
 *  - brevity: brief / balanced / thorough over an open how-to question that
 *    admits both a one-liner and a full walkthrough (tone left default). The
 *    three share an input so the run-level ordering check is a clean paired
 *    comparison.
 *  - control: neither slot set — the default `## Response Style` guidance, the
 *    behavioral no-op the assembly must preserve.
 *
 * Fragment TEXT is not written here; it is materialized from the one source
 * (`companion/config.ts`) in the suite's setup, keyed by these preset names.
 */

import type { EvalCase } from "../../framework/types"
import type { PersonaStyleInput, PersonaStyleExpected } from "./types"
import { BRIEF_MAX_WORDS, THOROUGH_MIN_WORDS } from "./config"

const TONE_MESSAGE =
  "I keep blowing past my own deadlines on this side project and honestly I'm pretty annoyed at myself about it. What do you make of that?"

const BREVITY_MESSAGE = "How should I set up a weekly review routine for my personal projects?"

export const personaStyleCases: EvalCase<PersonaStyleInput, PersonaStyleExpected>[] = [
  // --- tone axis (brevity left default) --------------------------------------
  {
    id: "tone-warm-001",
    name: "Warm tone reads as caring and encouraging",
    input: { dimension: "tone", tonePreset: "warm", message: TONE_MESSAGE },
    expectedOutput: { shouldRespond: true, tone: "warm" },
  },
  {
    id: "tone-neutral-001",
    name: "Neutral tone reads as even and matter-of-fact",
    input: { dimension: "tone", tonePreset: "neutral", message: TONE_MESSAGE },
    expectedOutput: { shouldRespond: true, tone: "neutral" },
  },
  {
    id: "tone-direct-001",
    name: "Direct tone reads as blunt and unhedged",
    input: { dimension: "tone", tonePreset: "direct", message: TONE_MESSAGE },
    expectedOutput: { shouldRespond: true, tone: "direct" },
  },

  // --- brevity axis (tone left default; shared message for the ordering check) --
  {
    id: "brevity-brief-001",
    name: "Brief slot yields a terse answer",
    input: { dimension: "brevity", brevityPreset: "brief", message: BREVITY_MESSAGE },
    expectedOutput: { shouldRespond: true, brevityBand: { maxWords: BRIEF_MAX_WORDS } },
  },
  {
    id: "brevity-balanced-001",
    name: "Balanced slot yields a mid-length answer",
    input: { dimension: "brevity", brevityPreset: "balanced", message: BREVITY_MESSAGE },
    expectedOutput: { shouldRespond: true },
  },
  {
    id: "brevity-thorough-001",
    name: "Thorough slot yields a comprehensive answer",
    input: { dimension: "brevity", brevityPreset: "thorough", message: BREVITY_MESSAGE },
    expectedOutput: { shouldRespond: true, brevityBand: { minWords: THOROUGH_MIN_WORDS } },
  },

  // --- control: neither slot set (default guidance preserved) -----------------
  {
    id: "control-unset-001",
    name: "No slots set still produces a response",
    input: { dimension: "control", message: BREVITY_MESSAGE },
    expectedOutput: { shouldRespond: true },
  },
]
