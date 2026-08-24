import { useEffect, useRef, useState } from "react"
import {
  EFFECTS_PER_SESSION_MAX,
  ToolVerificationStatuses,
  type AgentSessionStep,
  type AgentToolEffect,
} from "@threa/types"
import { useAgentTrace } from "@/hooks/use-agent-trace"
import { isDescribedEffect } from "@/lib/effect-links"
import { SessionEffectGrid } from "./session-effect-grid"

interface KeyedEffect {
  key: string
  effect: AgentToolEffect
}

/** Identity of the write itself, independent of which step reported it. */
function descriptorKey(effect: AgentToolEffect): string {
  return JSON.stringify([effect.kind, effect.label, effect.target, effect.before, effect.after])
}

/**
 * Every write a step has declared so far, in step order, keyed by where it came
 * from. The key is the step id plus the effect's index on that step, so the same
 * descriptor written by two different steps stays two rows while a re-delivery of
 * one step (bootstrap refetch, reconnect) collapses onto the row already shown.
 *
 * A denied guardian verdict contributes nothing: the call never ran, so it wrote
 * nothing (same rule as `trace-step.tsx`).
 */
function keyedStepEffects(steps: AgentSessionStep[]): KeyedEffect[] {
  const out: KeyedEffect[] = []
  for (const step of steps) {
    if (step.verification?.status === ToolVerificationStatuses.DENIED) continue
    for (const [index, effect] of (step.effects ?? []).entries()) {
      if (!isDescribedEffect(effect)) continue
      out.push({ key: `${step.id}:${index}`, effect })
    }
  }
  return out
}

/**
 * What the running turn has written so far, streamed onto the session card as
 * each tool returns rather than held back until the turn settles.
 *
 * The rows are APPEND-ONLY for the life of the turn (INV-21). The rendered list
 * is accumulated here rather than derived from the current step set, so nothing
 * already on screen can move or vanish when the upstream steps change: a
 * reconnect wipes `useAgentTrace`'s realtime map before the refetch lands, and a
 * late verdict can turn a step denied. Either would otherwise pull a row back
 * out from under the reader. The cap trims the tail, never the head.
 *
 * A separate component so the subscription can be conditional on the session
 * still running — the caller mounts it only then (INV-18).
 */
export function LiveSessionEffectGrid({
  workspaceId,
  sessionId,
  priorEffects,
}: {
  workspaceId: string
  sessionId: string
  /**
   * What earlier attempts of this session already wrote, from their `interrupted`
   * payloads. A retry is in flight — not terminal — so its writes have to stream
   * too, but `upsertStep` resets a step's effects on the retry, which makes those
   * earlier writes recoverable only from the payloads.
   */
  priorEffects?: AgentToolEffect[]
}) {
  const { steps } = useAgentTrace(workspaceId, sessionId)
  const shownKeys = useRef<Set<string>>(new Set())
  // Descriptors an earlier attempt already showed, as a multiset. A retry that
  // re-runs the same tool must not draw the same row twice, but a turn that
  // genuinely writes the same thing twice must still draw two — so a match is
  // consumed rather than remembered (the rule `unionSessionEffects` follows:
  // dedupe across attempts, never within one).
  const unclaimedPrior = useRef<Map<string, number> | null>(null)
  if (unclaimedPrior.current === null) {
    unclaimedPrior.current = new Map()
    for (const effect of priorEffects ?? []) {
      const key = descriptorKey(effect)
      unclaimedPrior.current.set(key, (unclaimedPrior.current.get(key) ?? 0) + 1)
    }
  }
  const [effects, setEffects] = useState<AgentToolEffect[]>(() => priorEffects ?? [])

  useEffect(() => {
    const additions: AgentToolEffect[] = []
    for (const entry of keyedStepEffects(steps)) {
      if (shownKeys.current.has(entry.key)) continue
      shownKeys.current.add(entry.key)
      const key = descriptorKey(entry.effect)
      const outstanding = unclaimedPrior.current?.get(key) ?? 0
      if (outstanding > 0) {
        unclaimedPrior.current?.set(key, outstanding - 1)
        continue
      }
      additions.push(entry.effect)
    }
    if (additions.length === 0) return
    setEffects((prev) => [...prev, ...additions].slice(0, EFFECTS_PER_SESSION_MAX))
  }, [steps])

  return <SessionEffectGrid effects={effects} />
}
