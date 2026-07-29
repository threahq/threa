import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { AGENT_OUTCOME_KINDS, AGENT_OUTCOME_STATES, type AgentOutcomeKind, type AgentOutcomeState } from "@threa/types"

// Namespaced because the attachment explorer is mounted on every workspace
// route, including this one, and claims the bare `streams` / `q` / `selected`.
export const OUTCOMES_PARAM = "agenda"
const STREAMS_PARAM = "aStreams"
const STATE_PARAM = "aState"
const KIND_PARAM = "aKind"
const QUERY_PARAM = "aq"
const SELECTED_PARAM = "aSelected"

export const DEFAULT_OUTCOMES_STATE: AgentOutcomeState = "outstanding"

export interface OutcomesFilters {
  /**
   * IDs of streams the user has scoped to. Empty means workspace-wide — the
   * scope chip's remove action writes exactly this.
   */
  streamIds: string[]
  state: AgentOutcomeState
  /** null = both kinds interleaved. */
  kind: AgentOutcomeKind | null
  queryText: string
  selectedOutcomeId: string | null
}

const STATE_SET = new Set<AgentOutcomeState>(AGENT_OUTCOME_STATES)
const KIND_SET = new Set<AgentOutcomeKind>(AGENT_OUTCOME_KINDS)

function parseStreamIds(raw: string | null): string[] {
  if (!raw) return []
  const ids = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  return Array.from(new Set(ids))
}

function parseState(raw: string | null): AgentOutcomeState {
  return raw && STATE_SET.has(raw as AgentOutcomeState) ? (raw as AgentOutcomeState) : DEFAULT_OUTCOMES_STATE
}

function parseKind(raw: string | null): AgentOutcomeKind | null {
  return raw && KIND_SET.has(raw as AgentOutcomeKind) ? (raw as AgentOutcomeKind) : null
}

export function readOutcomesFiltersFromParams(params: URLSearchParams): OutcomesFilters {
  return {
    streamIds: parseStreamIds(params.get(STREAMS_PARAM)),
    state: parseState(params.get(STATE_PARAM)),
    kind: parseKind(params.get(KIND_PARAM)),
    queryText: params.get(QUERY_PARAM) ?? "",
    selectedOutcomeId: params.get(SELECTED_PARAM) || null,
  }
}

export function isOutcomesOpen(params: URLSearchParams): boolean {
  return params.has(OUTCOMES_PARAM)
}

function applyFilter(params: URLSearchParams, key: string, value: string | null) {
  if (value === null || value === "") {
    params.delete(key)
  } else {
    params.set(key, value)
  }
}

export function writeOutcomesFiltersToParams(params: URLSearchParams, next: Partial<OutcomesFilters>): URLSearchParams {
  const updated = new URLSearchParams(params)

  if ("streamIds" in next) {
    const ids = next.streamIds ?? []
    if (ids.length === 0) updated.delete(STREAMS_PARAM)
    else updated.set(STREAMS_PARAM, Array.from(new Set(ids)).join(","))
  }
  if ("state" in next) {
    if (!next.state || next.state === DEFAULT_OUTCOMES_STATE) updated.delete(STATE_PARAM)
    else updated.set(STATE_PARAM, next.state)
  }
  if ("kind" in next) applyFilter(updated, KIND_PARAM, next.kind ?? null)
  if ("queryText" in next) applyFilter(updated, QUERY_PARAM, next.queryText ?? null)
  if ("selectedOutcomeId" in next) applyFilter(updated, SELECTED_PARAM, next.selectedOutcomeId ?? null)

  return updated
}

const OUTCOMES_KEYS = [OUTCOMES_PARAM, STREAMS_PARAM, STATE_PARAM, KIND_PARAM, QUERY_PARAM, SELECTED_PARAM]

/**
 * Outcomes view state lives entirely in URL search params (INV-59) so refresh,
 * back/forward, and a shared link all land on the same view. Mirrors
 * `use-explorer-url-state` — same open/close/update contract, and `close` strips
 * only the keys this surface owns so a host page's own params survive.
 */
export function useOutcomesUrlState() {
  const [searchParams, setSearchParams] = useSearchParams()

  const isOpen = isOutcomesOpen(searchParams)

  const filters = useMemo(() => readOutcomesFiltersFromParams(searchParams), [searchParams])

  const open = useCallback(
    (overrides?: Partial<OutcomesFilters>) => {
      const next = writeOutcomesFiltersToParams(searchParams, overrides ?? {})
      next.set(OUTCOMES_PARAM, "")
      setSearchParams(next, { replace: false })
    },
    [searchParams, setSearchParams]
  )

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    for (const key of OUTCOMES_KEYS) next.delete(key)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const update = useCallback(
    (overrides: Partial<OutcomesFilters>, options: { history?: "push" | "replace" } = {}) => {
      const next = writeOutcomesFiltersToParams(searchParams, overrides)
      setSearchParams(next, { replace: options.history !== "push" })
    },
    [searchParams, setSearchParams]
  )

  return { isOpen, filters, open, close, update }
}
