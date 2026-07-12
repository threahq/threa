/**
 * Brief Correction Test Cases
 *
 * The three arms of the correction loop (roadmap 4.4):
 *  (a) states-decision   — a durable decision is stated → the brief gains it
 *  (b) contradicts-brief — a standing brief fact is reversed → the brief is
 *                          replaced, not appended
 *  (c) chitchat          — transient banter → the brief is left untouched
 *
 * The chitchat arm is the trust-critical one: over-eager brief writes are the
 * failure mode 4.4 exists to catch, so it carries the tighter gate.
 */

import type { EvalCase } from "../../framework/types"
import type { BriefCorrectionInput, BriefCorrectionExpected } from "./types"

export const briefCorrectionCases: EvalCase<BriefCorrectionInput, BriefCorrectionExpected>[] = [
  // --- (a) states-decision: a durable decision should land in the brief -------
  {
    id: "states-decision-cadence-001",
    name: "Durable cadence decision is recorded",
    input: {
      category: "states-decision",
      conversationHistory: [
        { role: "user", content: "Been going back and forth on how often to send the newsletter." },
        { role: "assistant", content: "What are you weighing — reach vs. the effort to fill each issue?" },
      ],
      message: "Alright, decision made: the newsletter ships weekly, every Tuesday morning. Locking that in.",
    },
    expectedOutput: {
      shouldWrite: true,
      briefMustState: "The newsletter ships weekly, every Tuesday.",
    },
  },
  {
    id: "states-decision-convention-001",
    name: "Durable tooling convention is recorded",
    input: {
      category: "states-decision",
      conversationHistory: [
        { role: "user", content: "The repos are a mess — three different package managers across them." },
      ],
      message: "Going forward we standardize on pnpm for every repo. That's the rule now.",
    },
    expectedOutput: {
      shouldWrite: true,
      briefMustState: "pnpm is the standard package manager for all repos.",
    },
  },

  // --- (b) contradicts-brief: reversal replaces the fact, not appends ---------
  {
    id: "contradicts-brief-cadence-001",
    name: "Reversed cadence replaces the old value",
    input: {
      category: "contradicts-brief",
      existingBrief: "# Newsletter\n\n- The newsletter ships weekly, every Tuesday morning.",
      message: "Change of plan on the newsletter — we're moving it to every other Thursday instead of weekly Tuesdays.",
    },
    expectedOutput: {
      shouldWrite: true,
      briefMustState: "The newsletter ships every other Thursday.",
      briefMustNotState: "The newsletter ships weekly on Tuesday.",
    },
  },
  {
    id: "contradicts-brief-datastore-001",
    name: "Reversed datastore choice replaces the old value",
    input: {
      category: "contradicts-brief",
      existingBrief: "# Stack\n\n- Primary database is MySQL.\n- Deploys go out on Fridays.",
      message: "Heads up: we finished the migration off MySQL — Postgres is our primary database now.",
    },
    expectedOutput: {
      shouldWrite: true,
      briefMustState: "Postgres is the primary database.",
      briefMustNotState: "MySQL is the primary database.",
    },
  },

  // --- (c) chitchat: transient talk must not touch the brief ------------------
  {
    id: "chitchat-banter-001",
    name: "Banter yields no brief write",
    input: {
      category: "chitchat",
      message: "ugh this coffee is terrible today, third bad cup in a row lol",
    },
    expectedOutput: { shouldWrite: false },
  },
  {
    id: "chitchat-smalltalk-002",
    name: "Small talk yields no brief write",
    input: {
      category: "chitchat",
      conversationHistory: [
        { role: "user", content: "morning!" },
        { role: "assistant", content: "Morning — what's on today?" },
      ],
      message: "did you catch the game last night? absolutely wild finish",
    },
    expectedOutput: { shouldWrite: false },
  },
  {
    id: "chitchat-transient-with-brief-003",
    name: "Transient status leaves an existing brief untouched",
    input: {
      category: "chitchat",
      existingBrief: "# Working agreements\n\n- Standup is 9:30am daily.\n- Fridays are no-meeting days.",
      message: "brb grabbing lunch, back in 30",
    },
    expectedOutput: { shouldWrite: false },
  },
]
