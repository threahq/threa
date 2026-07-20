import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertExpectedHeads, createMergePlan, parseArgs } from "./merge-stack"

const stack = {
  number: 42,
  open: true,
  base: { ref: "main" },
  pull_requests: [
    {
      number: 101,
      state: "open" as const,
      draft: false,
      merged_at: null,
      head: { ref: "layer-one", sha: "aaa111" },
    },
    {
      number: 102,
      state: "open" as const,
      draft: false,
      merged_at: null,
      head: { ref: "layer-two", sha: "bbb222" },
    },
    {
      number: 103,
      state: "open" as const,
      draft: false,
      merged_at: null,
      head: { ref: "layer-three", sha: "ccc333" },
    },
  ],
}

async function createSubprocessFixture(chrome: string): Promise<{
  root: string
  runtime: string
  profile: string
  chromePath: string
  env: Record<string, string | undefined>
}> {
  const root = await mkdtemp(join(tmpdir(), "merge-stack-test-"))
  const runtime = join(root, "runtime")
  const profile = join(root, "profile", "Default")
  const bin = join(root, "bin")
  await mkdir(runtime, { recursive: true })
  await mkdir(profile, { recursive: true })
  await mkdir(bin, { recursive: true })
  await writeFile(join(root, "profile", "Local State"), "{}")
  const cookies = new Database(join(profile, "Cookies"), { create: true })
  cookies.exec("CREATE TABLE cookies (name TEXT)")
  cookies.close()

  const gh = join(bin, "gh")
  await writeFile(
    gh,
    `#!/bin/sh
printf '%s\\n' '[{"number":42,"open":true,"base":{"ref":"main"},"pull_requests":[{"number":101,"state":"open","draft":false,"merged_at":null,"head":{"ref":"layer-one","sha":"aaa111"}},{"number":102,"state":"open","draft":false,"merged_at":null,"head":{"ref":"layer-two","sha":"bbb222"}}]}]'
`
  )
  await chmod(gh, 0o700)

  const chromePath = join(root, "chrome")
  await writeFile(chromePath, chrome)
  return {
    root,
    runtime,
    profile,
    chromePath,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: runtime },
  }
}

async function waitForCopiedProfile(runtime: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readdir(runtime)).some((entry) => entry.startsWith("gh-stack-merge-"))) return
    await Bun.sleep(20)
  }
  throw new Error("temporary Chrome profile was not created")
}

describe("parseArgs", () => {
  test("parses an explicit merge", () => {
    expect(parseArgs(["#102", "--yes", "--method", "rebase", "--timeout", "60"])).toMatchObject({
      pullRequest: 102,
      method: "REBASE",
      timeoutSeconds: 60,
      yes: true,
      dryRun: false,
    })
  })

  test("requires exactly one execution mode", () => {
    expect(() => parseArgs(["102"])).toThrow("choose exactly one")
    expect(() => parseArgs(["102", "--yes", "--dry-run"])).toThrow("choose exactly one")
  })
})

describe("createMergePlan", () => {
  test("selects the target and every unmerged pull request below it", () => {
    expect(createMergePlan(stack, 102)).toEqual({
      stackNumber: 42,
      targetPullRequest: 102,
      baseRef: "main",
      entries: stack.pull_requests.slice(0, 2),
      expectedHeads: { 101: "aaa111", 102: "bbb222" },
    })
  })

  test("rejects a draft downstack pull request", () => {
    const blocked = structuredClone(stack)
    blocked.pull_requests[0]!.draft = true
    expect(() => createMergePlan(blocked, 102)).toThrow("#101 is draft")
  })
})

describe("assertExpectedHeads", () => {
  const plan = createMergePlan(stack, 102)

  test("rejects a head change after browser preflight", () => {
    const changed = structuredClone(stack)
    changed.pull_requests[1]!.head.sha = "changed"
    expect(() => assertExpectedHeads(plan, changed)).toThrow("#102 head changed")
  })

  test("rejects insertion, reorder, removal, and base changes", () => {
    const inserted = structuredClone(stack)
    inserted.pull_requests.splice(1, 0, {
      number: 104,
      state: "open",
      draft: false,
      merged_at: null,
      head: { ref: "inserted", sha: "ddd444" },
    })
    expect(() => assertExpectedHeads(plan, inserted)).toThrow("stack entries changed")

    const reordered = structuredClone(stack)
    reordered.pull_requests = [reordered.pull_requests[1]!, reordered.pull_requests[0]!, reordered.pull_requests[2]!]
    expect(() => assertExpectedHeads(plan, reordered)).toThrow("stack entries changed")

    const removed = structuredClone(stack)
    removed.pull_requests.splice(0, 1)
    expect(() => assertExpectedHeads(plan, removed)).toThrow("stack entries changed")

    const changedBase = structuredClone(stack)
    changedBase.base.ref = "release"
    expect(() => assertExpectedHeads(plan, changedBase)).toThrow("stack base changed")
  })
})

describe("credential cleanup", () => {
  test("removes copied browser state when Chrome exits during startup", async () => {
    const fixture = await createSubprocessFixture("#!/bin/sh\nexit 1\n")
    await chmod(fixture.chromePath, 0o700)
    try {
      const process = Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "merge-stack.ts"),
          "102",
          "--dry-run",
          "--repo",
          "owner/repo",
          "--chrome-bin",
          fixture.chromePath,
          "--chrome-profile",
          fixture.profile,
        ],
        { env: fixture.env, stdout: "ignore", stderr: "ignore" }
      )
      expect(await process.exited).not.toBe(0)
      expect(await readdir(fixture.runtime)).toEqual([])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`removes copied browser state on ${signal}`, async () => {
      const fixture = await createSubprocessFixture(`#!/bin/sh
trap 'kill "$child" 2>/dev/null; exit' INT TERM
sleep 60 & child=$!
wait "$child"
`)
      await chmod(fixture.chromePath, 0o700)
      try {
        const process = Bun.spawn(
          [
            "bun",
            join(import.meta.dir, "merge-stack.ts"),
            "102",
            "--dry-run",
            "--repo",
            "owner/repo",
            "--chrome-bin",
            fixture.chromePath,
            "--chrome-profile",
            fixture.profile,
          ],
          { env: fixture.env, stdout: "ignore", stderr: "ignore" }
        )
        await waitForCopiedProfile(fixture.runtime)
        process.kill(signal)
        await process.exited
        expect(await readdir(fixture.runtime)).toEqual([])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    })
  }
})
