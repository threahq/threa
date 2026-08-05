import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The three composers that host the stash picker render the landing-site-wide
// pile (`stash.drafts`), not the scope-exact `claimableDrafts` that gated it
// while a cross-scope restore was still unsafe. `claimableDrafts` stays — the
// `?stash=` deep link is exact-scope and single-host by design — so nothing but
// this guard stops a host from being wired back to it by reflex. A behavioural
// mount per host would pin the same one line at ten times the cost.
const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const HOSTS = [
  "components/timeline/message-input.tsx",
  "components/thread/stream-panel.tsx",
  "components/board/board-inline-composer.tsx",
]

describe("stash picker hosts render the shared pile", () => {
  it.each(HOSTS)("%s passes stash.drafts to the picker, never claimableDrafts", (file) => {
    const source = readFileSync(resolve(srcRoot, file), "utf8")
    expect(source).toMatch(/drafts[:=]\s*\{?stash\.drafts\}?/)
    expect(source).not.toMatch(/stash\.claimableDrafts/)
  })
})
