# Phase 5 — PR 6 (revised): Web tools + bounded research inside the enclave

> Executable companion to `.claude/plans/e2e-enclave-ssk.md` §5 "PR 6 — Web tools".
> Revised because PR #689 landed the **general researcher** after the SSK plan was
> written. The plan's PR 6 was "wire web_search + read_url"; we are shipping the
> richer surface the persona now has: the web primitives **and** a web-only
> `general_research` loop running inside the enclave. Decided with the user
> (2026-05-30): richer surface, and the researcher core extracted to the shared
> `@threa/agent-runtime` package (one implementation, no parallel copy — INV-35/37).

## 0. Why this shape

- The enclave already runs the real `AgentRuntime` loop with full tool-calling
  plumbing (`apps/enclave/src/agent/enclave-ai.ts` → `toOpenAiTools` →
  `rawChat` with `tool_choice:"auto"`). The loop is just handed `tools: []`
  today (`run-turn.ts:124`). So the loop side is ready.
- `web_search`/`read_url` already live in `@threa/agent-runtime` and call
  Tavily/`fetch` directly with SSRF guards — no backend callback, so they are
  enclave-safe as-is.
- `GeneralResearcher` (backend feature folder) takes `tools: AgentTool[]` as
  **input** — it does not build them. Its only backend-specific deps are `AI`
  and `ConfigResolver`, and the ConfigResolver only supplies `modelId`,
  `temperature`, `maxIterations`. Its real logic (bounded loop, deadline,
  partial-on-timeout, brief capture, source dedupe) is workspace-agnostic.
- The enclave's tool surface is the **web-only subset** of the research tool
  policy (`web_search`, `read_url`). Workspace/GitHub/Linear tools need backend
  callbacks the enclave deliberately cannot make (zero plaintext egress) — out
  of scope, and the researcher gracefully runs with whatever tools it is given.

## 1. Deliverable

Inside an E2E scratchpad, Ariadne can:
- call `web_search` / `read_url` directly, and
- call `general_research` for a bounded (~2 min) multi-step web investigation
  that returns a synthesised, cited brief,

with every tool step sealed under the SSK and streamed to the trace exactly like
`thinking`/`message:sent` already are (PR 5 / B2b). The server never sees
plaintext (INV-E7). OpenRouter stays the sole LLM egress; Tavily becomes the
only *new* outbound dependency, called directly from the enclave.

## 2. Work breakdown

### 2.1 Extract the researcher core to `@threa/agent-runtime` (INV-35/37)

New `packages/agent-runtime/src/research/general-researcher.ts`:
- Move the `GeneralResearcher` class + `GeneralResearchInput`/`Result`/`Substep`
  types and `buildUserPrompt`/`clip` helpers verbatim.
- Replace the `ConfigResolver` dependency with explicit constructor/`research()`
  params: `modelId`, `temperature`, `maxIterations`, `maxBriefChars`,
  `totalBudgetMs` already arrive via `deadlineAt`. The prompt
  (`GENERAL_RESEARCH_SYSTEM_PROMPT`) and numeric defaults move to a
  package-level `research/config.ts` (shared source of truth — INV-33/44).
- `ResearchProgressObserver` moves alongside (it implements `AgentObserver`,
  already a package concept).
- Keep `AI`, `AgentRuntime`, `mergeSourceItems`, `composeAbortSignal`,
  `isAbortError` deps — all already in the package (`composeAbortSignal` moves
  from `apps/backend/src/lib/abort-signal.ts` to the package; backend
  `WorkspaceAgent` + general-research-tool re-import from the barrel).
- Export from the package barrel.

Backend `apps/backend/src/features/agents/general-researcher/`:
- Re-export the moved class/types from the package (thin shim) OR update
  importers to the package path; delete the moved implementation (INV-38, no
  deprecated aliases — INV-49). `config.ts` keeps the backend-only
  `GENERAL_RESEARCH_TOOL_POLICY` (it references `AgentToolNames` for the
  *backend* tool catalog) and re-exports the shared prompt/budgets.
- The backend's `GeneralResearcher` construction now passes the resolved config
  values explicitly instead of handing in a `ConfigResolver`.

### 2.2 Enclave-safe web tool assembly

New `apps/enclave/src/agent/tools.ts`:
- `buildEnclaveTools({ tavilyApiKey, currentTime, timezone })` →
  `[createWebSearchTool(...), createReadUrlTool()]` (the two enclave-safe
  primitives) + the enclave `general_research` tool (2.3). Web key gates
  `web_search`/research-web exactly like `buildToolSet` does; `read_url` always
  available.
- No `enabledTools` gating knob in this slice — the enclave persona (Ariadne)
  gets the full enclave-safe set. (Persona-level tool config for the enclave is
  a later concern; out of scope, INV-36.)

### 2.3 Enclave `general_research` wiring

- Reuse `createGeneralResearchTool` from the package (it is pure: takes a
  `runGeneralResearch` callback). The enclave supplies a callback that
  constructs the extracted `GeneralResearcher` with `createEnclaveAI` (same AI
  the turn uses, so usage accumulates into the same `UsageAccumulator`) and the
  web-only tool subset, and runs it.
- The researcher's inner loop runs entirely in-process — no backend round-trip.
  Its sources/brief fold into the persona turn exactly as on the backend.

### 2.4 Trace: tool steps

- `EnclaveTraceObserver.toStepDescriptor` (`trace-observer.ts:70`) currently maps
  only `thinking`/`message:sent`. Extend it to the tool-step events the loop now
  emits (`tool:call`/`tool:result` → `web_search`/`read_url`/`research` step
  types, mirroring the backend `SessionTraceObserver` mapping). Each new step
  seals under the SSK and streams back unchanged — the B2b pipeline already
  persists + decrypts any step type.
- Verify the substep/progress events the research tool emits (`onProgress`) are
  sealed too, or are intentionally dropped (decide against the backend
  observer's behavior; match it).

### 2.5 Config + request plumbing

- `EnclaveConfig` gains `tavilyApiKey?: string` (optional: no key → no
  `web_search`, `read_url` + research still work for URL reads). `TAVILY_API_KEY`
  env, **not** in the required list (graceful absence — INV-11 is about silent
  *wrong* defaults, not optional capabilities; absence is logged).
- `run-turn.ts`: replace `tools: []` with `tools: buildEnclaveTools(...)`,
  threading `currentTime`/`timezone` from the assignment if present (else
  omitted). `EnclaveTurnDeps` gains the tool config.
- No new backend request fields strictly required for the web subset (the
  enclave owns its Tavily key + builds its own tools). Confirm during impl that
  `currentTime`/`timezone` grounding is available or acceptably omitted.

## 3. Tests

- Package: move + keep the existing `general-researcher.test.ts` (now against the
  package), green. Add a web-only-tools research round-trip.
- Enclave: `buildEnclaveTools` returns the expected set with/without a Tavily
  key; `run-turn` drives a tool call end-to-end (spy `rawChat` returns a
  `tool_calls` response, assert the tool executes and a sealed tool step is
  streamed via `onStep`). Extend `trace-observer.test.ts` for the new step types.
- Backend: importers compile against the package; existing companion/researcher
  suites stay green (no behavior change — INV-22).
- Bundle audit: enclave bundle still has 0 `opentelemetry`/`langchain`; new
  egress limited to `api.tavily.com` + `openrouter.ai`. Re-run the audit.

## 4. Invariants

INV-35/37 (one researcher impl, shared package — the whole point), INV-28 (AI via
`createAI`/`createEnclaveAI` only), INV-19 (usage accumulates via the shared
`UsageAccumulator` → sidecar), INV-E7 (tool steps sealed; server sees ciphertext),
INV-33/44 (research prompt + budgets centralized in package config, shared by
backend + enclave), INV-38/49 (delete moved code, no deprecated aliases),
INV-36 (no enabledTools knob / no speculative persona config this slice),
INV-48 (spy `rawChat`/namespace; no `vi.mock` of the shared runtime).

## 5. Out of scope

Workspace/GitHub/Linear tools in the enclave (need backend callbacks — violates
zero-egress). Persona-level enclave tool configuration. Streaming research
substeps to a dedicated UI surface beyond the existing sealed-step trace.
Temporal grounding (`currentTime`/`timezone`) for the enclave's web search — the
assignment doesn't carry it yet; `buildEnclaveTools` already accepts it for when
the request-builder does.

## 6. As-built notes

- The `general_research` TOOL wrapper moved to the package too (not just the
  loop), since it is pure and both hosts need it — backend keeps its path via a
  re-export shim. The loop's run-input type was renamed `GeneralResearchRunInput`
  to avoid colliding with the tool wrapper's `{query}` input.
- Fixed a latent bundle leak surfaced by this slice: `web-search-tool.ts` and
  `read-url-tool.ts` imported `defineAgentTool` from the heavy `../runtime`
  barrel (which re-exports `OtelObserver`). Harmless on the backend, but once the
  enclave imported these tools it pulled OpenTelemetry into the bundle (0 → 49).
  Repointed both at `../runtime/agent-tool` directly; audit back to 0.
