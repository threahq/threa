import { describe, expect, test } from "bun:test"
import { renderPush } from "../render"
import { evaluatePush, foldCohorts, foldOutcomes, type PushReport, type ReceiptCohort } from "./push"

const outcomes = (over: Partial<NonNullable<PushReport["outcomes"]>["since"]> = {}) => ({
  accepted: 0,
  rejected: 0,
  unreachable: 0,
  registrationGone: 0,
  workerFailed: 0,
  notSent: 0,
  retried: 0,
  ...over,
})

const cohort = (over: Partial<ReceiptCohort> = {}): ReceiptCohort => ({
  eligible: 0,
  confirmed: 0,
  created: 0,
  suppressed: 0,
  creationFailed: 0,
  excluded: {
    revoked: 0,
    not_accepted: 0,
    unarmed_send: 0,
    consent: 0,
    policy: 0,
    endpoint_unknown: 0,
    collapsed: 0,
    collapse_uncertain: 0,
  },
  ...over,
})

const report = (over: Partial<Omit<PushReport, "findings">> = {}): Omit<PushReport, "findings"> => ({
  outcomes: { since: outcomes(), prior: outcomes() },
  backlog: { pending: 0, retrying: 0, overdue: 0, oldestDueSec: null },
  receipts: { state: "measured", windowMs: 24 * 3_600_000, current: cohort(), baseline: cohort() },
  unavailable: [],
  ...over,
})

const receipts = (current: ReceiptCohort, baseline: ReceiptCohort = cohort()): PushReport["receipts"] => ({
  state: "measured",
  windowMs: 24 * 3_600_000,
  current,
  baseline,
})

const ids = (r: Omit<PushReport, "findings">) => evaluatePush(r).map((finding) => finding.id)

describe("evaluatePush", () => {
  test("should report nothing when push is quiet", () => {
    expect(evaluatePush(report())).toEqual([])
  })

  test("should not alarm on a small receipt cohort, however bad its ratio", () => {
    expect(
      ids(report({ receipts: receipts(cohort({ eligible: 29, confirmed: 0 }), cohort({ eligible: 29 })) }))
    ).toEqual([])
  })

  test("should warn on a receipt shortfall only when the whole 95% interval is below the floor", () => {
    expect(evaluatePush(report({ receipts: receipts(cohort({ eligible: 60, confirmed: 15 })) }))).toEqual([
      {
        level: "warn",
        id: "push.receipts.shortfall",
        message:
          "push receipts: only 15/60 matured deliveries confirmed by the device (25%, 95% upper 37% < 50%); unconfirmed, not proven lost",
      },
    ])
    expect(ids(report({ receipts: receipts(cohort({ eligible: 60, confirmed: 26 })) }))).toEqual([])
  })

  test("should warn on a drop against the previous matured window only when both windows have a sample and the intervals separate", () => {
    const healthyBaseline = cohort({ eligible: 100, confirmed: 95 })
    expect(ids(report({ receipts: receipts(cohort({ eligible: 80, confirmed: 50 }), healthyBaseline) }))).toEqual([
      "push.receipts.drop",
    ])
    expect(ids(report({ receipts: receipts(cohort({ eligible: 80, confirmed: 70 }), healthyBaseline) }))).toEqual([])
    expect(
      ids(
        report({ receipts: receipts(cohort({ eligible: 80, confirmed: 50 }), cohort({ eligible: 10, confirmed: 10 })) })
      )
    ).toEqual([])
  })

  test("should warn when devices report notification creation failures", () => {
    expect(ids(report({ receipts: receipts(cohort({ eligible: 40, confirmed: 36, creationFailed: 4 })) }))).toEqual([
      "push.receipts.creation_failed",
    ])
  })

  test("should warn on a provider rejection burst with a sample, and not on a handful of failures", () => {
    const burst = report({
      outcomes: {
        since: outcomes({ accepted: 30, rejected: 6, unreachable: 4 }),
        prior: outcomes({ accepted: 40 }),
      },
    })
    expect(evaluatePush(burst)).toEqual([
      {
        level: "warn",
        id: "push.transport",
        message:
          "push: 10/40 device deliveries ended in provider failure since baseline (25%: rejected 6, unreachable 4; prior 0/40)",
      },
    ])
    expect(ids(report({ outcomes: { since: outcomes({ accepted: 3, rejected: 5 }), prior: outcomes() } }))).toEqual([])
  })

  test("should not count expired registrations or unsent deliveries as provider failures", () => {
    const churn = report({
      outcomes: { since: outcomes({ accepted: 30, registrationGone: 20, notSent: 200 }), prior: outcomes() },
    })
    expect(ids(churn)).toEqual([])
  })

  test("should warn on worker failures and an overdue backlog", () => {
    expect(
      ids(
        report({
          outcomes: { since: outcomes({ workerFailed: 1 }), prior: outcomes() },
          backlog: { pending: 9, retrying: 2, overdue: 3, oldestDueSec: 900 },
        })
      )
    ).toEqual(["push.worker_failed", "push.backlog"])
  })

  test("should say a missing schema is unavailable rather than report zeros", () => {
    const missing = report({
      outcomes: null,
      backlog: null,
      receipts: { state: "unavailable", reason: "schema not migrated" },
      unavailable: [
        { part: "outcomes", detail: "device outcomes and backlog: push_deliveries missing" },
        { part: "receipts", detail: "receipt cohorts: push_receipts or push_deliveries.sent_* missing" },
      ],
    })
    expect(ids(missing)).toEqual(["push.unavailable.outcomes", "push.unavailable.receipts"])
    expect(renderPush({ ...missing, findings: [] })).toEqual([
      "push      durable device deliveries (first-party ledger)",
      "  unavailable: device outcomes and backlog: push_deliveries missing",
      "  unavailable: receipt cohorts: push_receipts or push_deliveries.sent_* missing",
    ])
  })
})

describe("folding query rows", () => {
  test("should bucket terminal statuses by their recorded reason, not by whether an attempt preceded them", () => {
    expect(
      foldOutcomes([
        { win: "since", status: "accepted", reason: null, deliveries: "7", retried: "2" },
        { win: "since", status: "rejected", reason: "rejected", deliveries: "1", retried: "0" },
        { win: "since", status: "rejected", reason: "invalid_registration", deliveries: "1", retried: "0" },
        { win: "since", status: "failed", reason: "max_attempts", deliveries: "1", retried: "1" },
        { win: "since", status: "expired", reason: "retry_window_closed", deliveries: "2", retried: "2" },
        { win: "since", status: "expired", reason: "expired", deliveries: "3", retried: "0" },
        { win: "since", status: "failed", reason: "infrastructure", deliveries: "2", retried: "1" },
        { win: "since", status: "registration_gone", reason: null, deliveries: "4", retried: "0" },
        { win: "prior", status: "suppressed", reason: "prefs", deliveries: "5", retried: "0" },
      ])
    ).toEqual({
      since: outcomes({
        accepted: 7,
        rejected: 2,
        unreachable: 3,
        registrationGone: 4,
        workerFailed: 2,
        notSent: 3,
        retried: 6,
      }),
      prior: outcomes({ notSent: 5 }),
    })
  })

  test("should keep excluded receipt rows out of the denominator and numerator", () => {
    expect(
      foldCohorts([
        {
          cohort: "current",
          class: "eligible",
          deliveries: "5",
          confirmed: "4",
          created: "3",
          suppressed: "1",
          creation_failed: "0",
        },
        {
          cohort: "current",
          class: "collapsed",
          deliveries: "6",
          confirmed: "1",
          created: "1",
          suppressed: "0",
          creation_failed: "0",
        },
        {
          cohort: "baseline",
          class: "consent",
          deliveries: "2",
          confirmed: "2",
          created: "2",
          suppressed: "0",
          creation_failed: "0",
        },
      ])
    ).toEqual({
      current: cohort({
        eligible: 5,
        confirmed: 4,
        created: 3,
        suppressed: 1,
        excluded: { ...cohort().excluded, collapsed: 6 },
      }),
      baseline: cohort({ excluded: { ...cohort().excluded, consent: 2 } }),
    })
  })
})

describe("renderPush", () => {
  test("should label a small cohort insufficient evidence instead of a ratio", () => {
    const lines = renderPush({
      ...report({
        receipts: receipts(
          cohort({ eligible: 4, confirmed: 4, created: 4 }),
          cohort({ eligible: 40, confirmed: 36, created: 36 })
        ),
      }),
      findings: [],
    })
    expect(lines.slice(5)).toEqual([
      "  receipts: automatic deliveries matured (capability expired) in the last 24h vs the 24h before",
      "  current   insufficient evidence: 4 eligible (4 confirmed), not a health signal",
      "  baseline  36/40 confirmed by the device (90%, 95% 77%–96%): created 36, suppressed 0, creation failed 0",
      "  (a report means the worker got the push; it never proves the OS showed it or anyone saw it)",
    ])
  })
})
