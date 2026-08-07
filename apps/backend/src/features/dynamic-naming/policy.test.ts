import { describe, expect, test } from "bun:test"
import { getNamingEligibility, reduceNamingProgress, resetNamingProgress, type NamingProgress } from "./policy"

const initial = (overrides: Partial<NamingProgress> = {}): NamingProgress => ({
  lastEvaluatedMessageCount: 0,
  consecutiveKeeps: 0,
  completed: false,
  structureVersion: 0,
  lastEvaluatedStructureVersion: 0,
  ...overrides,
})

describe("dynamic naming policy", () => {
  test.each([
    [1, 1, false],
    [2, 1, false],
    [3, 3, true],
    [7, 6, true],
    [10, 10, true],
    [99, 10, true],
  ] as const)("count %i selects checkpoint %i", (count, checkpoint, forced) => {
    expect(getNamingEligibility(initial(), count)).toEqual({ eligible: true, checkpoint, forced, structural: false })
  })

  test("selects only highest newly crossed checkpoint", () => {
    expect(getNamingEligibility(initial({ lastEvaluatedMessageCount: 1 }), 7)).toEqual({
      eligible: true,
      checkpoint: 6,
      forced: true,
      structural: false,
    })
  })

  test("defer is restricted to checkpoint 1", () => {
    const progress = initial()
    expect(() =>
      reduceNamingProgress(
        progress,
        { eligible: true, checkpoint: 3, forced: true, structural: false },
        { action: "defer" },
        3
      )
    ).toThrow()
    expect(
      reduceNamingProgress(
        progress,
        { eligible: true, checkpoint: 1, forced: false, structural: false },
        { action: "defer" },
        1
      ).lastEvaluatedMessageCount
    ).toBe(1)
  })

  test("two ordinary keeps settle", () => {
    const first = reduceNamingProgress(
      initial(),
      { eligible: true, checkpoint: 1, forced: false, structural: false },
      { action: "keep" },
      1
    )
    const second = reduceNamingProgress(
      first,
      { eligible: true, checkpoint: 3, forced: true, structural: false },
      { action: "keep" },
      3
    )
    expect(second).toMatchObject({ consecutiveKeeps: 2, completed: true })
  })

  test("rename resets keeps and checkpoint 10 completes", () => {
    const renamed = reduceNamingProgress(
      initial({ consecutiveKeeps: 1 }),
      { eligible: true, checkpoint: 6, forced: true, structural: false },
      { action: "rename", title: "New" },
      6
    )
    expect(renamed).toMatchObject({ consecutiveKeeps: 0, completed: false })
    expect(
      reduceNamingProgress(
        renamed,
        { eligible: true, checkpoint: 10, forced: true, structural: false },
        { action: "rename", title: "Final" },
        10
      ).completed
    ).toBe(true)
  })

  test("structural work remains eligible after settlement and keep consumes no ordinary progress", () => {
    const settled = initial({
      lastEvaluatedMessageCount: 10,
      consecutiveKeeps: 2,
      completed: true,
      structureVersion: 2,
      lastEvaluatedStructureVersion: 1,
    })
    const eligibility = getNamingEligibility(settled, 12)
    expect(eligibility).toEqual({ eligible: true, checkpoint: 10, forced: true, structural: true })
    const next = reduceNamingProgress(
      settled,
      eligibility as Extract<typeof eligibility, { eligible: true }>,
      { action: "keep" },
      12
    )
    expect(next).toEqual({ ...settled, lastEvaluatedStructureVersion: 2 })
  })

  test("regenerate clears settlement and creates structural work", () => {
    const reset = resetNamingProgress(
      initial({
        lastEvaluatedMessageCount: 10,
        consecutiveKeeps: 2,
        completed: true,
        structureVersion: 4,
        lastEvaluatedStructureVersion: 4,
      })
    )
    expect(reset).toMatchObject({
      lastEvaluatedMessageCount: 0,
      consecutiveKeeps: 0,
      completed: false,
      structureVersion: 5,
      lastEvaluatedStructureVersion: 4,
    })
  })
})
