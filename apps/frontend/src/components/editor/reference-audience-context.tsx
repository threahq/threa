import { createContext, useContext } from "react"
import type { ReferenceAudience } from "@threahq/types"

export const AUDIENCE_TONE_TEXT = {
  unreachable: "text-amber-600 dark:text-amber-400",
  reveal: "text-sky-600 dark:text-sky-400",
} as const

export const NO_REFERENCE_AUDIENCE: ReadonlyMap<string, ReferenceAudience> = new Map()

/**
 * Source streams whose readers differ from the composer's destination, keyed by
 * stream id. Only a send-checking composer provides it; every other editor sees
 * the empty map and renders its references untinted.
 */
export const ReferenceAudienceContext = createContext<ReadonlyMap<string, ReferenceAudience>>(NO_REFERENCE_AUDIENCE)

export function useReferenceExposed(streamId: string | null | undefined): boolean {
  const audienceByStreamId = useContext(ReferenceAudienceContext)
  return !!streamId && audienceByStreamId.has(streamId)
}
