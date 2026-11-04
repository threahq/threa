import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { areaSpecs, areas, browserModules, mainOnlySpecs, planCi, smokeSpec } from "./ci-policy"

const modules = browserModules()
const inventory = [...modules.keys()].filter((file) => file.endsWith(".spec.ts"))
const noGates = { app_update: false, public_site: false, extensions: false }

function pr(...changed: string[]) {
  return planCi({ eventName: "pull_request", changed, modules })
}

describe("CI policy", () => {
  test("should run only the base and smoke for a change outside every area", () => {
    expect(pr("apps/backend/src/features/messaging/event-service.ts")).toEqual({
      browser: [smokeSpec],
      gates: noGates,
      reasons: [],
    })
  })

  test("should add a touched area's specs on top of smoke", () => {
    const plan = pr("apps/frontend/src/calls/call-session.ts")
    expect(plan.browser).toContain("tests/browser/calls.spec.ts")
    expect(plan.browser).toContain(smokeSpec)
    expect(plan.reasons).toEqual(["calls: apps/frontend/src/calls/call-session.ts"])
  })

  test("should select timeline, composer and docs specs from their sources", () => {
    const examples: [string, string][] = [
      ["apps/frontend/src/components/timeline/stream-content.tsx", "tests/browser/infinite-scroll.spec.ts"],
      ["apps/frontend/src/components/timeline/message-reactions.tsx", "tests/browser/message-reactions.spec.ts"],
      ["apps/frontend/src/components/editor/rich-editor.tsx", "tests/browser/rich-text-editing.spec.ts"],
      ["packages/prosemirror/src/markdown.ts", "tests/browser/markdown-shortcuts.spec.ts"],
      ["apps/backend/src/features/docs/service.ts", "tests/browser/doc-pane.spec.ts"],
    ]
    const missed = examples.filter(([source, spec]) => !pr(source).browser.includes(spec))
    expect(missed).toEqual([])
  })

  test("should run a changed spec without its whole area", () => {
    expect(pr("tests/browser/doc-chips.spec.ts").browser).toEqual(["tests/browser/doc-chips.spec.ts", smokeSpec])
  })

  test("should run the specs importing a changed browser test module", () => {
    expect(pr("tests/browser/render-budgets.ts").browser).toEqual(["tests/browser/render-budget.spec.ts", smokeSpec])
  })

  test("should run every browser spec when the shared harness changes", () => {
    expect(pr("tests/browser/helpers.ts").browser).toBe("all")
    expect(pr("playwright.config.ts").browser).toBe("all")
  })

  test("should gate app-update, public site and extensions on their paths", () => {
    expect(pr("apps/frontend/src/hooks/use-app-update.ts").gates).toEqual({ ...noGates, app_update: true })
    expect(pr("apps/public-site/src/pages/index.astro").gates).toEqual({ ...noGates, public_site: true })
    expect(pr("extensions/threa-bot/src/index.ts").gates).toEqual({ ...noGates, extensions: true })
  })

  test("should open every gate when CI infrastructure changes", () => {
    for (const file of [
      "bun.lock",
      ".github/workflows/ci.yml",
      ".github/workflows/regression-tests.yml",
      ".github/actions/setup-bun/action.yml",
    ]) {
      expect(pr(file)).toEqual({
        browser: [smokeSpec],
        gates: { app_update: true, public_site: true, extensions: true },
        reasons: [`ci infrastructure: ${file}`],
      })
    }
  })

  test("should run everything outside pull requests", () => {
    expect(planCi({ eventName: "push", changed: [], modules })).toMatchObject({
      browser: "all",
      gates: { app_update: true, public_site: true, extensions: true },
    })
  })

  test("should give every browser spec an area or a main-only entry", () => {
    const covered = new Set([smokeSpec, ...areas.flatMap((area) => areaSpecs(area, inventory))])
    const mainOnly = inventory.filter((spec) =>
      mainOnlySpecs.includes(spec.slice("tests/browser/".length, -".spec.ts".length))
    )
    expect({
      unclassified: inventory.filter((spec) => !covered.has(spec) && !mainOnly.includes(spec)),
      claimedByAnArea: mainOnly.filter((spec) => covered.has(spec)),
      missing: mainOnlySpecs.filter((name) => !inventory.includes(`tests/browser/${name}.spec.ts`)),
    }).toEqual({ unclassified: [], claimedByAnArea: [], missing: [] })
  })

  test("should point every area source and spec prefix at tracked files", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0")
    const deadSources = areas.flatMap((area) =>
      area.sources.filter((prefix) => !tracked.some((file) => file.startsWith(prefix))).map((p) => `${area.name}: ${p}`)
    )
    const deadSpecs = areas.flatMap((area) =>
      area.specs
        .filter((prefix) => !inventory.some((spec) => spec.startsWith(`tests/browser/${prefix}`)))
        .map((p) => `${area.name}: ${p}`)
    )
    expect({ deadSources, deadSpecs }).toEqual({ deadSources: [], deadSpecs: [] })
  })
})
