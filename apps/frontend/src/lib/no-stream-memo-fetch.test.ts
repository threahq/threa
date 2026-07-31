import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// No lazy loading in the stream. A memo embed card renders the content that
// arrived with the message and nothing else — its content may change only when
// the memo changed (`memo:updated`), never because it had not loaded yet. The
// per-card `useMemoDetail` round trip is what made cards grow under the reader
// on first paint, and removing it is only durable if nothing quietly adds it
// back: a card is one `useMemoDetail(...)` away from the old behaviour, and the
// symptom (a jump on a cold load) does not reproduce on a warm dev machine.
//
// Two callers are legitimate and named below. Everything else that renders in a
// stream, a thread panel, or a board card must take its content from the payload.

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Files allowed to fetch a memo's detail.
 *
 * - `memo-preview-dialog` opens ON a click — user-initiated, and the only place
 *   the memo's substance (abstract, key points, sources) is access-checked.
 * - `memory` is the explorer page, which is a memo browser.
 * - `use-memo-embed-source` / `memo-embed-view` are the COMPOSER's chip: it
 *   resolves a pasted memo link so the node can be stamped before sending. The
 *   composer is not the stream.
 */
const ALLOWED = [
  "components/memo/memo-preview-dialog.tsx",
  "pages/memory.tsx",
  "hooks/use-memo-embed-source.ts",
  "components/editor/memo-embed-view.tsx",
  "hooks/use-memos.ts",
  "hooks/index.ts",
]

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

describe("no per-card memo fetch in the stream", () => {
  it("keeps useMemoDetail out of everything but the dialog, the explorer and the composer", () => {
    const violations: string[] = []
    for (const file of collectSourceFiles(srcRoot)) {
      const rel = relative(srcRoot, file)
      if (ALLOWED.includes(rel)) continue
      if (/\buseMemoDetail\b/.test(readFileSync(file, "utf8"))) violations.push(rel)
    }

    expect(violations).toEqual([])
  })

  it("names only files that exist, so the allowlist can't rot into a blanket exemption", () => {
    const present = new Set(collectSourceFiles(srcRoot).map((file) => relative(srcRoot, file)))
    expect(ALLOWED.filter((entry) => !present.has(entry))).toEqual([])
  })
})
