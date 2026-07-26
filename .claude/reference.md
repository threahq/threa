# Threa Reference (On-Demand Context)

This file contains detailed reference material not needed every turn. Read when working on relevant areas.

---

## Tech Stack

**Backend:**

- Runtime: Bun
- Framework: Express.js v5
- Database: PostgreSQL via `pg` + `squid` (template tag SQL)
- Migrations: Umzug
- WebSocket: Socket.io with `@socket.io/postgres-adapter`
- Auth: WorkOS AuthKit (production) + stub (dev/testing)
- Job Queue: Custom PostgreSQL queue (replaced pg-boss)
- Storage: S3-compatible (MinIO for local)
- IDs: ULID (prefixed, sortable)
- Logging: Pino
- AI: Vercel AI SDK + LangChain/LangGraph + OpenRouter
- Schema: Zod
- Testing: Bun test + Playwright

**Frontend:**

- Framework: React 19
- Build: Vite
- Routing: react-router-dom v7
- Real-time: socket.io-client
- State: TanStack Query + Dexie (IndexedDB)
- UI Components: Shadcn UI (Radix primitives)
- Styling: Tailwind CSS
- Editor: Tiptap (ProseMirror)
- Testing: Vitest + Testing Library, Playwright for browser testing

---

## Design System References

**Primary documentation:**

- `docs/design-system.md` - Comprehensive design system guide (typography, colors, components, patterns)
- `docs/design-system-kitchen-sink.html` - Interactive reference with all UI components and patterns

**Implementing UI components:**

1. Check `docs/design-system.md` for design decisions, patterns
2. Reference `docs/design-system-kitchen-sink.html` for visual examples, CSS implementation
3. When adding new components or patterns, update BOTH files

Kitchen sink is living reference - update when adding components, patterns, or styling. Serves as documentation and visual regression test.

---

## Local Development (Agent-Friendly)

Browser automation testing (Chrome DevTools MCP):

```bash
# Start services with stub auth
bun run dev:test

# Access at http://localhost:5173
# Stub auth: any email works, no password required
# Default workspace auto-created on first access
```

Stub mode bypasses WorkOS, creates test users on-demand. All features work except production auth.

**See:** `docs/agent-testing-guide.md` for comprehensive testing workflows and `docs/agent-testing-quick-reference.md` for quick patterns.

---

## Shadcn UI

Always use Shadcn UI components (INV-14). Components copied into codebase, not imported from npm.

**Add components:**

```bash
cd apps/frontend
bunx shadcn@latest add <component-name>
```

**Golden Thread theme**: Warm neutrals + gold accents. Use gold sparingly. Custom utilities: `thread-gradient`, `text-thread`, `border-thread`, `thread-glow`.

---

## Core Concepts

**Streams** - Everything that can send messages. Types: scratchpad (personal notes + AI companion, auto-named), channel (team chat, unique slug), dm (two or more members, computed display name, supports group DMs), thread (nested discussions, unlimited depth, inherits visibility from rootStreamId). All have visibility (public/private), companionMode (on/off), optional companionPersonaId.

**Memos (GAM)** - Semantic pointers preserving knowledge without copying. Store abstract + sourceMessageIds for navigation. Pipeline: message arrival -> MemoAccumulator (30s debounce, 5min max) -> Classifier (knowledge-worthiness) -> Memorizer (title, abstract, keyPoints, tags, sourceMessageIds) -> Enrichment (embeddings). Types: decision, learning, procedure, context, reference. Lifecycle: draft -> active -> archived | superseded.

**Personas** - Data-driven AI agents (not hardcoded). System personas (workspaceId=NULL, available to all) vs Workspace personas (single workspace). Invocation: companion mode (stream-level), mentions (@persona-slug), agent sessions. Each has enabledTools[] (send_message, web_search, read_url, create_memo, search_memos). Default: Ariadne (persona_system_ariadne).

**See:** `docs/core-concepts.md` for detailed explanations, pipelines, and implementation notes.

---

## AI Integration

Multi-provider system using **OpenRouter** for unified billing. All AI calls go through wrapper (`createAI()`) providing:

- Clean telemetry API (no `experimental_` prefixes)
- Automatic structured output repair (markdown fences, field normalization)
- Unified `{ value, response, usage }` return types
- Cost tracking (recorded to `ai_usage_records` when context provided)
- Thread-safe cost tracking for LangChain/LangGraph via `CostTracker` + `CostTrackingCallback`

**Model format:** `provider:modelPath` (e.g., `openrouter:anthropic/claude-haiku-4.5`)

**Usage:**

```typescript
const { value } = await ai.generateObject({
  model: "openrouter:anthropic/claude-haiku-4.5",
  schema: mySchema,
  messages: [...],
  telemetry: { functionId: "memo-classify", metadata: {...} },  // INV-19: required
  context: { workspaceId, userId }  // For cost tracking
})
```

See `docs/model-reference.md` for recommended models (INV-16). All AI wrapper calls require `telemetry.functionId` (INV-19).

**See:** `docs/backend/ai-integration.md` for configuration, cost tracking, repair functions, and LangChain integration.

---

## Development

### Primary Folder Workflow (`/threa`)

**Database, infrastructure run ONLY in primary folder:**

```bash
# First time: Start database
bun run db:start

# Run migrations (start app, wait for migrations, kill)
bun run dev
# Ctrl+C after migrations complete

# Reset database (destroys data)
bun run db:reset
```

**IMPORTANT:** Never run `db:start` or `db:reset` from worktrees. Infrastructure in primary folder only.

### Git Worktrees (Feature Development)

All feature work in worktrees for branch isolation:

```bash
# From /threa (on main): create worktree with brace expansion
git worktree add -b {,~/dev/personal/threa.}feature-name main
cd ~/dev/personal/threa.feature-name

# Set up worktree (copies .env, installs packages, creates branched database, copies Claude config)
bun run setup:worktree

# Start development (uses database from primary folder's postgres)
bun run dev
```

**Brace expansion explained:** `{,~/dev/personal/threa.}feature-name` expands to create branch `feature-name` at path `~/dev/personal/threa.feature-name`.

**How it works:**

- Worktree gets its own database (e.g., `threa_feature_name`)
- Database branches from primary folder's current state
- Shares same postgres container (no new docker services)
- Independent .env, node_modules, .claude config

**Testing in worktrees:**

```bash
cd apps/backend
bun run test              # All tests
bun run test:unit         # Unit tests (fast, no db)
bun run test:integration  # Integration tests (with test db)
bun run test:e2e          # E2E tests
```
