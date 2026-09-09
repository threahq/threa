import { describe, expect, test } from "bun:test"
import { findOrphanedWebServers, parseProcessInfo } from "./orphan-sweep"

const table = `
    1       0 /sbin/init
  100       1 bun scripts/test-silent.ts browser tests/browser/calls.spec.ts
  101     100 bunx playwright test tests/browser/calls.spec.ts
  102     101 /bin/sh -c bun tests/browser/fake-cf-runner.ts
  103     102 bun tests/browser/fake-cf-runner.ts
  104     101 /bin/sh -c bun tests/browser/setup-infra.ts && bun run test:browser:backend
  105     104 bun run test:browser:backend
  106     105 bun apps/backend/src/index.ts
  200       1 /bin/sh -c bun tests/browser/fake-cf-runner.ts
  201     200 bun tests/browser/fake-cf-runner.ts
  300       1 bun run test:browser:control-plane
  301     300 bun apps/control-plane/src/index.ts
  400       1 bun apps/backend/src/index.ts
`

describe("findOrphanedWebServers", () => {
  test("keeps servers under a live Playwright run and flags reparented ones", () => {
    const orphans = findOrphanedWebServers(parseProcessInfo(table)).map((row) => row.pid)
    expect(orphans).toEqual([200, 201, 300])
  })

  test("ignores servers that are not started by the browser config", () => {
    const rows = parseProcessInfo(table).filter((row) => row.pid === 400 || row.pid === 1)
    expect(findOrphanedWebServers(rows)).toEqual([])
  })
})
