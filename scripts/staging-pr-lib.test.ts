import { describe, expect, test } from "bun:test"
import { classifyStagingOrphans, stagingResourceNames } from "./staging-pr-lib"

describe("stagingResourceNames", () => {
  test("derives every per-PR name from the number", () => {
    expect(stagingResourceNames(228)).toEqual({
      pr: 228,
      prDbName: "pr_228",
      prCpDbName: "pr_228_cp",
      regionName: "pr-228",
      serviceName: "pr-228-backend",
      prHostname: "pr-228-staging.threa.io",
    })
  })
})

describe("classifyStagingOrphans", () => {
  test("keeps an open+labeled PR whose full resource set exists", () => {
    const plan = classifyStagingOrphans({
      serviceNames: ["pr-500-backend"],
      dbNames: ["pr_500", "pr_500_cp"],
      kvRegionKeys: ["pr-500"],
      openLabeledPrNumbers: [500],
    })

    expect(plan.orphans).toEqual([])
    expect(plan.keep).toEqual([{ pr: 500, hasService: true, hasDb: true, hasCpDb: true, hasKvRegion: true }])
  })

  test("keeps an open+labeled PR even when only some resources exist (partial deploy)", () => {
    const plan = classifyStagingOrphans({
      serviceNames: [],
      dbNames: ["pr_501"],
      kvRegionKeys: [],
      openLabeledPrNumbers: [501],
    })

    expect(plan.orphans).toEqual([])
    expect(plan.keep).toEqual([{ pr: 501, hasService: false, hasDb: true, hasCpDb: false, hasKvRegion: false }])
  })

  test("flags a DB-only orphan whose service was already hand-deleted (real case: #1252)", () => {
    const plan = classifyStagingOrphans({
      serviceNames: [],
      dbNames: ["pr_1252", "pr_1252_cp"],
      kvRegionKeys: [],
      openLabeledPrNumbers: [],
    })

    expect(plan.keep).toEqual([])
    expect(plan.orphans).toEqual([{ pr: 1252, hasService: false, hasDb: true, hasCpDb: true, hasKvRegion: false }])
  })

  test("flags a KV-only orphan", () => {
    const plan = classifyStagingOrphans({
      serviceNames: [],
      dbNames: [],
      kvRegionKeys: ["pr-1050"],
      openLabeledPrNumbers: [],
    })

    expect(plan.orphans).toEqual([{ pr: 1050, hasService: false, hasDb: false, hasCpDb: false, hasKvRegion: true }])
  })

  test("handles a control-plane DB (pr_N_cp) present without its backend DB (pr_N)", () => {
    const plan = classifyStagingOrphans({
      serviceNames: [],
      dbNames: ["pr_777_cp"],
      kvRegionKeys: [],
      openLabeledPrNumbers: [],
    })

    expect(plan.orphans).toEqual([{ pr: 777, hasService: false, hasDb: false, hasCpDb: true, hasKvRegion: false }])
  })

  test("never classifies shared infra or deleted-service suffix names", () => {
    const plan = classifyStagingOrphans({
      // Deleted Railway services get a UUID suffix and must NOT match `-backend$`.
      serviceNames: [
        "backend",
        "control-plane",
        "Postgres",
        "railway",
        "pr-1252-backend-47675d47-0f2c-4a9b-bd11-deadbeef00",
      ],
      dbNames: ["postgres", "template0", "template1", "staging_main", "staging_main_cp"],
      kvRegionKeys: ["staging"],
      openLabeledPrNumbers: [],
    })

    expect(plan.orphans).toEqual([])
    expect(plan.keep).toEqual([])
  })

  test("ignores non-canonical digit strings — teardown re-derives names, so pr_0123 must not become pr_123", () => {
    const plan = classifyStagingOrphans({
      serviceNames: ["pr-0300-backend"],
      dbNames: ["pr_0123", "pr_0123_cp"],
      kvRegionKeys: ["pr-007"],
      openLabeledPrNumbers: [],
    })

    expect(plan.orphans).toEqual([])
    expect(plan.keep).toEqual([])
  })

  test("unions candidates across sources and sorts orphans by PR number", () => {
    const plan = classifyStagingOrphans({
      serviceNames: ["pr-300-backend"],
      dbNames: ["pr_100", "pr_100_cp", "pr_300"],
      kvRegionKeys: ["pr-200"],
      openLabeledPrNumbers: [300],
    })

    expect(plan.orphans).toEqual([
      { pr: 100, hasService: false, hasDb: true, hasCpDb: true, hasKvRegion: false },
      { pr: 200, hasService: false, hasDb: false, hasCpDb: false, hasKvRegion: true },
    ])
    expect(plan.keep).toEqual([{ pr: 300, hasService: true, hasDb: true, hasCpDb: false, hasKvRegion: false }])
  })
})
