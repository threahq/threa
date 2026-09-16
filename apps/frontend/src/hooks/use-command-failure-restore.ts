import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import type { CommandDispatchedPayload, CommandFailedPayload, JSONContent } from "@threahq/types"
import { db } from "@/db"
import { queueContentHandoff } from "@/stores/composer-handoff-store"

interface CommandOutcome {
  optimisticId: string
  failed: boolean
}

/**
 * Gives a dispatched command's content back to the composer that sent it when
 * the command fails. Tracking is component state, so the restore only ever
 * lands in the still-mounted sender; leaving the composer drops the claim.
 *
 * @param streamId - Stream whose commands this composer dispatches.
 * @returns `remember`, called with the optimistic event id and the doc that was sent.
 * @example
 * const remember = useCommandFailureRestore(streamId)
 * remember(await queueCommand(params), content)
 */
export function useCommandFailureRestore(streamId: string): (optimisticEventId: string, content: JSONContent) => void {
  const [tracked, setTracked] = useState<ReadonlyMap<string, JSONContent>>(() => new Map())
  const handledRef = useRef<Set<string>>(new Set())

  const remember = useCallback((optimisticEventId: string, content: JSONContent) => {
    setTracked((previous) => new Map(previous).set(optimisticEventId, content))
  }, [])

  const outcomes = useLiveQuery<CommandOutcome[]>(async () => {
    if (tracked.size === 0) return []
    const dispatched = await db.events
      .where("eventType")
      .equals("command_dispatched")
      .filter((event) => {
        if (event.streamId !== streamId) return false
        const payload = event.payload as CommandDispatchedPayload
        return tracked.has(event.id) || (payload.clientCommandId != null && tracked.has(payload.clientCommandId))
      })
      .toArray()
    if (dispatched.length === 0) return []

    const optimisticByCommandId = new Map<string, string>()
    for (const event of dispatched) {
      const payload = event.payload as CommandDispatchedPayload
      const optimisticId = tracked.has(event.id) ? event.id : payload.clientCommandId
      if (optimisticId) optimisticByCommandId.set(payload.commandId, optimisticId)
    }

    const terminal = await db.events
      .where("eventType")
      .anyOf(["command_failed", "command_completed"])
      .filter(
        (event) =>
          event.streamId === streamId && optimisticByCommandId.has((event.payload as CommandFailedPayload).commandId)
      )
      .toArray()

    return terminal.map((event) => ({
      optimisticId: optimisticByCommandId.get((event.payload as CommandFailedPayload).commandId)!,
      failed: event.eventType === "command_failed",
    }))
  }, [streamId, tracked])

  useEffect(() => {
    if (!outcomes?.length) return
    const settled: string[] = []
    for (const outcome of outcomes) {
      if (handledRef.current.has(outcome.optimisticId)) continue
      handledRef.current.add(outcome.optimisticId)
      settled.push(outcome.optimisticId)
      const content = tracked.get(outcome.optimisticId)
      if (outcome.failed && content) queueContentHandoff(streamId, content.content ?? [])
    }
    if (settled.length === 0) return
    setTracked((previous) => {
      const next = new Map(previous)
      for (const id of settled) next.delete(id)
      return next
    })
  }, [outcomes, streamId, tracked])

  return remember
}
