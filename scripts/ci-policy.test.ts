import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseNameStatus, planCi, type Change, type CiInput } from "./ci-policy"

const browserInventory = execFileSync("git", ["ls-files", "-z", "tests/browser/*.spec.ts"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)

function input(changes: Change[], overrides: Partial<CiInput> = {}): CiInput {
  return { eventName: "pull_request", labels: [], changes, browserInventory, ...overrides }
}

describe("CI policy", () => {
  test("should select protected and owner browser files for a composer source change", () => {
    const plan = planCi(input([{ status: "M", path: "apps/frontend/src/components/composer/message-composer.tsx" }]))
    expect(plan).toMatchObject({
      mode: "targeted",
      frontendShards: [1],
      browserShards: [1, 2, 3],
      frontendSources: ["apps/frontend/src/components/composer/message-composer.tsx"],
    })
    expect(plan.frontendTests).toContain("apps/frontend/src/lib/no-happy-path-success-toast.test.ts")
    expect(plan.browserFiles).toContain("tests/browser/doc-pane.spec.ts")
    expect(plan.browserFiles).toContain("tests/browser/send-tail-stability.spec.ts")
  })

  test("should select actual docs, saved, timeline, settings, and sidebar owners", () => {
    const examples = [
      ["apps/frontend/src/components/docs/doc-pane-body.tsx", "tests/browser/doc-pane.spec.ts"],
      ["apps/frontend/src/pages/saved.tsx", "tests/browser/saved-reminder.spec.ts"],
      ["apps/frontend/src/components/timeline/stream-content.tsx", "tests/browser/initial-reveal.spec.ts"],
      [
        "apps/frontend/src/components/settings/notifications-settings.tsx",
        "tests/browser/push-notification-settings.spec.ts",
      ],
      ["apps/frontend/src/components/layout/sidebar/sidebar.tsx", "tests/browser/sidebar-pick.spec.ts"],
    ]
    for (const [source, browser] of examples) {
      const plan = planCi(input([{ status: "M", path: source! }]))
      expect(plan.mode).toBe("targeted")
      expect(plan.browserFiles).toContain(browser!)
    }
  })

  test("should include exact new frontend and browser tests deterministically", () => {
    const changes = [
      { status: "A", path: "apps/frontend/src/components/docs/new.test.tsx" },
      { status: "M", path: "tests/browser/doc-title.spec.ts" },
      { status: "M", path: "apps/frontend/src/components/docs/doc-pane-body.tsx" },
      { status: "M", path: "apps/frontend/src/components/docs/doc-pane-body.tsx" },
    ]
    const plan = planCi(input(changes))
    expect(plan.frontendTests).toContain("apps/frontend/src/components/docs/new.test.tsx")
    expect(plan.browserFiles).toContain("tests/browser/doc-title.spec.ts")
    expect(plan.browserFiles).toEqual([...new Set(plan.browserFiles)].sort())
    expect(plan.frontendSources).toEqual(["apps/frontend/src/components/docs/doc-pane-body.tsx"])
  })

  test("should make ci:full sticky only while label is present", () => {
    const changes = [{ status: "M", path: "apps/frontend/src/pages/saved.tsx" }]
    expect(planCi(input(changes, { labels: ["ci:full"] }))).toMatchObject({ mode: "full", reason: "ci:full label" })
    expect(planCi(input(changes)).mode).toBe("targeted")
  })

  test("should require full for non-PR and every uncertain mixed diff", () => {
    const narrow = { status: "M", path: "apps/frontend/src/pages/saved.tsx" }
    expect(planCi(input([narrow], { eventName: "push" })).mode).toBe("full")
    for (const change of [
      { status: "M", path: "apps/backend/src/features/events/service.ts" },
      { status: "M", path: "packages/types/src/index.ts" },
      { status: "M", path: "apps/frontend/src/sync/stream-sync.ts" },
      { status: "M", path: "apps/frontend/src/components/ui/button.tsx" },
      { status: "M", path: "apps/frontend/src/components/settings/appearance-settings.tsx" },
      { status: "M", path: "apps/frontend/src/components/settings/call-settings.tsx" },
      { status: "M", path: "apps/frontend/src/test/setup.ts" },
      { status: "M", path: "bun.lock" },
      { status: "M", path: ".github/workflows/ci.yml" },
      { status: "D", path: "apps/frontend/src/pages/saved.tsx" },
      { status: "R100", path: "apps/frontend/src/pages/saved.tsx" },
      { status: "C100", path: "apps/frontend/src/pages/saved.tsx" },
    ]) {
      const plan = planCi(input([narrow, change]))
      expect(plan.mode).toBe("full")
      expect(plan.frontendShards).toEqual([1, 2, 3, 4, 5, 6])
      expect(plan.browserShards).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    }
    expect(planCi(input([])).mode).toBe("full")
  })

  test("should fail when a protected browser spec is absent", () => {
    const inventory = browserInventory.filter((path) => path !== "tests/browser/rich-text-editing.spec.ts")
    expect(() =>
      planCi(input([{ status: "M", path: "apps/frontend/src/pages/saved.tsx" }], { browserInventory: inventory }))
    ).toThrow("selected browser file missing from inventory")
  })

  test("should parse complete NUL-separated git name status and reject truncation", () => {
    expect(parseNameStatus("M\0a\0A\0b\0R100\0old\0new\0")).toEqual([
      { status: "M", path: "a" },
      { status: "A", path: "b" },
      { status: "R100", path: "old" },
    ])
    expect(() => parseNameStatus("M\0a")).toThrow("incomplete")
  })

  test("should plan from the whole PR merge-base diff in the CLI", () => {
    const repo = mkdtempSync(join(tmpdir(), "threa-ci-policy-"))
    const script = resolve(import.meta.dir, "ci-policy.ts")
    const inventoryPath = join(repo, "inventory.json")
    const eventPath = join(repo, "event.json")
    const outputPath = join(repo, "plan.json")
    const githubOutput = join(repo, "github-output.txt")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
    const run = (base: string, head: string, labels: string[] = []) => {
      writeFileSync(githubOutput, "")
      writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: { base: { sha: base }, head: { sha: head }, labels: labels.map((name) => ({ name })) },
        })
      )
      execFileSync(
        "bun",
        [
          script,
          "--event",
          eventPath,
          "--event-name",
          "pull_request",
          "--inventory",
          inventoryPath,
          "--json",
          outputPath,
        ],
        {
          cwd: repo,
          env: { ...process.env, GITHUB_OUTPUT: githubOutput, GITHUB_STEP_SUMMARY: join(repo, "summary.md") },
        }
      )
      const plan = JSON.parse(readFileSync(outputPath, "utf8")) as {
        mode: string
        reason: string
        frontendSources: string[]
      }
      const outputs = readFileSync(githubOutput, "utf8")
      return {
        ...plan,
        runFrontend: outputs.match(/^run_frontend=(true|false)$/m)?.[1],
        browserShardCount: outputs.match(/^browser_shard_count=(\d+)$/m)?.[1],
      }
    }
    try {
      git("init", "-q")
      git("config", "user.email", "ci-policy@example.invalid")
      git("config", "user.name", "CI Policy Test")
      writeFileSync(inventoryPath, JSON.stringify(browserInventory))
      writeFileSync(join(repo, "README.md"), "base\n")
      git("add", ".")
      git("commit", "-qm", "base")
      const base = git("rev-parse", "HEAD")
      mkdirSync(join(repo, "apps/frontend/src/pages"), { recursive: true })
      writeFileSync(join(repo, "apps/frontend/src/pages/saved.tsx"), "export {}\n")
      git("add", "apps/frontend/src/pages/saved.tsx")
      git("commit", "-qm", "frontend")
      const narrow = git("rev-parse", "HEAD")
      expect(run(base, narrow)).toMatchObject({
        mode: "targeted",
        frontendSources: ["apps/frontend/src/pages/saved.tsx"],
        runFrontend: "true",
        browserShardCount: "3",
      })
      expect(run(base, narrow, ["ci:full"])).toMatchObject({
        mode: "full",
        reason: "ci:full label",
        runFrontend: "true",
        browserShardCount: "8",
      })
      mkdirSync(join(repo, "tests/browser"), { recursive: true })
      writeFileSync(join(repo, "tests/browser/doc-title.spec.ts"), "export {}\n")
      git("add", "tests/browser/doc-title.spec.ts")
      git("commit", "-qm", "browser")
      expect(run(narrow, git("rev-parse", "HEAD"))).toMatchObject({ mode: "targeted", runFrontend: "false" })
      mkdirSync(join(repo, "apps/backend/src"), { recursive: true })
      writeFileSync(join(repo, "apps/backend/src/service.ts"), "export {}\n")
      git("add", "apps/backend/src/service.ts")
      git("commit", "-qm", "backend")
      expect(run(base, git("rev-parse", "HEAD"))).toMatchObject({ mode: "full" })
      writeFileSync(eventPath, JSON.stringify({ pull_request: { labels: [] } }))
      expect(() =>
        execFileSync(
          "bun",
          [
            script,
            "--event",
            eventPath,
            "--event-name",
            "pull_request",
            "--inventory",
            inventoryPath,
            "--json",
            outputPath,
          ],
          { cwd: repo, stdio: "pipe" }
        )
      ).toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
