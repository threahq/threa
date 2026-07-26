# CLAUDE.md Context Management

This document describes the three-phase approach used to revise and optimize Threa's CLAUDE.md file for improved quality, scannability, and context efficiency.

> Status note: This is a historical process log. The current canonical rules live in `/Users/kristofferremback/dev/personal/threa/CLAUDE.md` under **Invariant Playbook (Narrative)** and **Quick Invariant Lookup**.

## Goal

Compact and improve CLAUDE.md quality through factual corrections, documentation extraction, and aggressive compression while preserving all critical information.

## Three-Phase Approach

### Phase 1: Factual Corrections

Review each section for outdated or incorrect information. Update to reflect current state of the codebase.

**Examples of corrections made:**

- **Runtime & Build**: Fixed `bun test` → `bun run test` (accurate command)
- **Project Structure**: Updated to include `packages/`, `scripts/`, `tests/` directories
- **Tech Stack**: Comprehensive update with accurate technology list
- **Local Development**: Added NEW section for agent-friendly stub auth mode
- **Core Concepts**: Expanded with accurate Streams/Memos/Personas details
- **Architecture Patterns**: Massively expanded from 4 to 9+ patterns
- **Invariants**: Added INV-30 through INV-40 (11 new invariants)
- **Backend Architecture**: NEW compact section replacing Service Guidelines
- **AI Integration**: Updated with wrapper details and cost tracking
- **Development**: Restructured to emphasize primary folder vs worktrees
- **Agent Workflow**: REMOVED entirely (divergence protocol was failed experiment)
- **Lessons Learned**: Removed 13 lessons now covered by invariants

**Documentation created:**

- `docs/model-reference.md` - AI model recommendations with pricing
- `docs/agent-testing-guide.md` - Comprehensive browser testing guide (668 lines)
- `docs/agent-testing-quick-reference.md` - Quick reference for testing (161 lines)
- `.claude/skills/search-model/SKILL.md` - OpenRouter API search skill

### Phase 2: Documentation Extraction

Move detailed concept explanations and component descriptions to `./docs/` for reference. Keep only essential rules and quick reference information in CLAUDE.md.

#### Extraction Principle

**"Would I think to look for it if I know about it?" → Extract with summary.**

**"Would I not know to look for it?" → Keep in CLAUDE.md.**

This principle guides extraction decisions:

- **Extract**: Detailed explanations of concepts you already know exist (Streams, Memos, Architecture Patterns). Once you know these exist, you'll look them up when needed.
- **Keep**: Unknown unknowns, gotchas, and anti-patterns you wouldn't think to search for (Lessons Learned, Invariants). These prevent mistakes you don't know to avoid.

#### Documents Extracted

**`docs/core-concepts.md` (240 lines)** - Detailed explanations of:

- Streams (4 types: scratchpad, channel, dm, thread)
- Memos/GAM (philosophy, 5-step pipeline, types, lifecycle)
- Personas (system vs workspace, invocation methods, enabled tools)
- Relationships between concepts
- Implementation notes (database tables, constraints, event-driven architecture)

**`docs/architecture.md` (727 lines)** - Comprehensive patterns with code examples:

- Repository Pattern (with anti-patterns)
- Service Layer (withTransaction vs withClient vs direct pool)
- Outbox Pattern + Listeners (architecture diagram, cursor-based processing)
- Event Sourcing + Projections
- Job Queue + Workers
- Middleware Composition
- Handler Factory Pattern
- Database Pool Separation
- Cursor Lock + Time-Based Locking

#### CLAUDE.md Updates

**Core Concepts**: Compressed from 47 lines to 5 lines

- Preserved all keywords: scratchpad, channel, dm, thread, visibility, companionMode, MemoAccumulator, Classifier, Memorizer, Enrichment, enabledTools, Ariadne
- Added reference: "See: `docs/core-concepts.md`"

**Architecture Patterns**: Compressed from 123 lines to 11 lines

- Preserved all pattern names and key concepts
- Added reference: "See: `docs/architecture.md`"

**Invariants Format (historical at that revision)**: Converted table to list

- Replaced 3-column table with bold list items: `**INV-X: Name** - Description`
- Reduced horizontal whitespace from column padding
- Improved scannability and readability

**Results:**

- **CLAUDE.md**: 404 lines → 441 lines (slight increase due to Prettier formatting, but much more readable)
- **Documentation**: Two new comprehensive reference docs (967 total lines of detailed patterns and explanations)
- **Keyword preservation**: All searchable terms remain in CLAUDE.md for "aha!" moments
- **Unknown unknowns**: Lessons Learned section kept in CLAUDE.md

### Phase 3: Compression

Remove filler words, simplify language, eliminate redundancy while preserving all information.

#### Compression Strategy

Systematically remove:

- Unnecessary articles ("the", "a") where meaning remains clear
- Filler words that don't change meaning ("and" → "," in many contexts)
- Redundant phrases ("for reusability" when implied)
- Verbose constructions ("which provides" → "providing")
- Unnecessary qualifiers ("actually", "really")

#### Examples

**What Is This section:**

```markdown
# Before

Threa tackles "Slack, where critical information comes to die" by building a knowledge foundation around your organization using language models. The core differentiator is GAM (General Agentic Memory) - automatically extracting and preserving knowledge from conversations.

# After

Threa tackles "Slack, where critical information comes to die" by building knowledge foundations using language models. Core differentiator: GAM (General Agentic Memory) - auto-extracts and preserves knowledge from conversations.
```

**Design System References:**

```markdown
# Before

**When implementing UI components:**
The kitchen sink is a living reference - update it whenever you add new components, patterns, or styling.

# After

**Implementing UI components:**
Kitchen sink is living reference - update when adding components, patterns, or styling.
```

**INV-9: No Singletons:**

```markdown
# Before

Pass dependencies explicitly; no module-level state or `getInstance()` patterns. Exceptions: (1) Logger (Pino) - stateless and side-effect-free. (2) Web-push bootstrap - the library configures itself at module load.

# After

Pass dependencies explicitly; no module-level state or `getInstance()`. Exceptions: (1) Logger (Pino) - stateless, side-effect-free. (2) Web-push bootstrap - library self-configures at module load.
```

**INV-13: Construct, Don't Assemble:**

```markdown
# Before

Never `doThing(deps, params)` where caller assembles deps. Instead, construct objects with their deps at startup (`new Thing(deps)`), then callers just call `thing.doThing(params)`.

# After

Never `doThing(deps, params)` where caller assembles deps. Construct objects with deps at startup (`new Thing(deps)`), then call `thing.doThing(params)`.
```

**INV-20: No Select-Then-Update:**

```markdown
# Before

Never do SELECT-then-UPDATE/INSERT without proper concurrency control. This pattern has race conditions.

# After

Never SELECT-then-UPDATE/INSERT without concurrency control. Has race conditions.
```

**INV-27: Prefer Generic Repository Methods:**

```markdown
# Before

Don't add single-use repository methods when a generic method can be reused. If you need `getRecentScratchpadDisplayNames`, check if `list()` with filters covers the use case. Repositories should be powerful and composable, not cluttered with specialized variants. When ten ways exist to get the same data, it's unclear which to use.

# After

Don't add single-use repository methods when generic method can be reused. Need `getRecentScratchpadDisplayNames`? Check if `list()` with filters works. Repositories should be powerful, composable, not cluttered with specialized variants. Ten ways to get same data = unclear which to use.
```

**Lessons Learned - Abstractions should fully own their domain:**

```markdown
# Before

A helper that extracts part of a workflow but leaves the caller managing the rest adds indirection without reducing complexity. If you're creating an abstraction for session lifecycle, it should handle find/create, run work, AND track status - not just find/create while the caller still manages status with separate calls. Partial abstractions can be worse than no abstraction because they add a layer of indirection while still requiring the caller to understand the full workflow.

# After

Helper extracting part of workflow but leaving caller managing rest adds indirection without reducing complexity. Creating abstraction for session lifecycle? It should handle find/create, run work, AND track status - not just find/create while caller manages status with separate calls. Partial abstractions can be worse than none - they add indirection while requiring caller understand full workflow.
```

**Comprehensive Invariants Compression (INV-9 through INV-40):**

- INV-9: "and side-effect-free" → ", side-effect-free"
- INV-13: Removed "Instead," and "just"
- INV-14: "Install missing components via" → "Install missing components:"
- INV-17: "Migrations that have been committed are immutable - they may have already run on databases" → "Committed migrations are immutable - may have already run"
- INV-18: "This isn't" → "Not", "A `sidebar.tsx` should contain" → "`sidebar.tsx` contains"
- INV-19: "This enables" → "Enables", "The `functionId` should describe" → "`functionId` describes"
- INV-20: "Never do SELECT-then-UPDATE/INSERT without proper concurrency control. This pattern has race conditions" → "Never SELECT-then-UPDATE/INSERT without concurrency control. Has race conditions"
- INV-22: "A failing test means one of:" → "Failing test means:", "and didn't realize it" → removed
- INV-23: "the number of events emitted" → "event count", "Instead, verify that" → "Verify"
- INV-24: "of the same object" → "of same object", "and compare with" → ", compare with"
- INV-25: "Future readers don't care what the code used to be" → "Future readers don't care what code used to be"
- INV-26: "If a test cannot be made to pass" → "If test can't pass"
- INV-27: "when a generic method can be reused" → "when generic method can be reused"
- INV-28: "or `embedMany`" → `, `embedMany`", "which provides:" → "providing:"
- INV-29: "(e.g., different stream types)" → "(e.g., stream types)"
- INV-30: "only when multiple queries need" → "only for multiple queries needing"
- INV-32: "and `code`" → ", `code`", ", not response formatting" → removed
- INV-33: "or enums" → "/enums", "and import them" → ", import them"
- INV-35: "either the helper is inadequate" → "means helper is inadequate"
- INV-36: "A comment about hypothetical modes creates confusion" → "Comments about hypothetical modes create confusion"
- INV-37: "and confuses readers about which to use" → ", confuses readers", "The question" → removed
- INV-39: "Unit tests that mock too much" → "Unit tests mocking too much"
- INV-40: "(submit, open modal, delete)" → "(submit, modal, delete)"

**Other sections compressed:**

- **Backend Architecture**: "format responses" → "format response", "from starving" → "starving"
- **AI Integration**: "as unified billing interface" → "for unified billing", "which provides:" → "providing:"
- **Development**: "Database and infrastructure" → "Database, infrastructure", "let migrations run, then kill" → "wait for migrations, kill", "All feature work happens in worktrees to keep branches isolated" → "All feature work in worktrees for branch isolation"
- **Lessons Learned**: Multiple compressions throughout

#### Results

- **98 word-level changes** (49 insertions, 49 deletions)
- **Character count**: 26,685 → 25,214 characters (1,471 characters removed, 5.5% compression)
- **Line count**: 441 lines (unchanged)
- **All information preserved** - compression achieved through removing filler, not content
- **Improved scannability** - more direct, concise statements

## Key Takeaways

1. **Three phases work well together**: Factual corrections first ensure accuracy, extraction moves detailed content to appropriate locations, compression tightens remaining content.

2. **Extraction principle is critical**: The "would I look for it?" test creates clear guidance for what stays vs. what goes. Unknown unknowns (lessons learned, gotchas) stay; detailed explanations of known concepts get extracted.

3. **Keyword preservation matters**: During extraction, preserve all searchable keywords in CLAUDE.md for "aha!" moments when AI assistants search for concepts.

4. **Compression is aggressive but safe**: Removing grammatical fluff ("the", "and" → ",", "which provides" → "providing") achieves 5.5% compression without losing information.

5. **Line count is misleading**: Phase 2 increased line count (404 → 441) due to formatting, but actual content density improved dramatically (extracted 967 lines of detail to separate files).

6. **Invariants need examples**: Many invariants became clearer with compression - removing filler revealed the core rule more directly.

## Applying This Process to Other Projects

This three-phase approach can be applied to any large context documentation:

1. **Phase 1: Accuracy** - Ensure content reflects current reality
2. **Phase 2: Extraction** - Move detailed explanations to separate docs, keep essential rules
3. **Phase 3: Compression** - Remove linguistic fluff while preserving information

The extraction principle ("would I look for it if I knew about it?") works well for deciding what to extract vs. keep inline.
