---
name: typecheck
description: Run TypeScript type checking across the entire monorepo
allowed-tools: Bash(bun run typecheck:*), Bash(bun run --cwd:*)
---

# Typecheck

`bun run typecheck` is targeted by default: pass the packages you touched, in dependency order.

```bash
bun run typecheck apps/backend packages/types 2>&1
```

With no arguments it refuses — a full monorepo `tsc` peaks near 2 GB per workspace and this box runs many worktrees at once. `bun run typecheck --all` runs the whole chain, serialized against other heavy jobs by a cross-worktree lock. CI runs `--all` implicitly on every push.

## Chain order

`packages/types` → `packages/prosemirror` → `packages/crypto` → `packages/backend-common` → `packages/agent-runtime` → `packages/cli` → `apps/backend` → `apps/control-plane` → `apps/workspace-router` → `apps/backoffice-router` → `apps/frontend` → `apps/backoffice` → `apps/db-read-proxy` → `apps/enclave` → `apps/public-site` → `typecheck:monitor`.

The run stops at the first failing package.

## Reporting

Errors follow `path/file.ts(line,col): error TSXXXX: message`. Group them by package and file, read the surrounding code before proposing a fix, and report as:

```
Typecheck found N errors in M files:

**apps/backend** (X errors)
  - `src/path/file.ts:42` — TS2345: description + suggested fix
```

Common patterns:

- **TS6133 (unused variable)** — remove it, or prefix with `_` (backend only; frontend's `noUnusedLocals` ignores the prefix)
- **TS2345 / TS2322 (type mismatch)** — check whether an upstream type or constant changed
- **TS2307 (cannot find module)** — check for a moved file and update the import

## Notes

- Backend typechecks `src/**/*` and `evals/**/*`, plus `tsconfig.tests.json`
- Frontend sets `noUnusedLocals` and `noUnusedParameters` — stricter than backend
- Packages run sequentially because they depend on each other
