import { describe, it, expect } from "bun:test"
import type { AnalyticsEvent, AnalyticsReporter } from "@threahq/backend-common"
import { PushTelemetry } from "./telemetry"
import type { PushSendKind, PushSuppressionReason } from "./outcome"

class RecordingReporter implements AnalyticsReporter {
  events: AnalyticsEvent[] = []
  captureException(): void {}
  captureEvent(event: AnalyticsEvent): void {
    this.events.push(event)
  }
  async shutdown(): Promise<void> {}
}

const accepted = { outcome: "accepted", statusCode: 201, errorCode: null } as const

describe("PushTelemetry", () => {
  it("should flush windowed counts as person-less service events without identifiers", () => {
    const reporter = new RecordingReporter()
    const telemetry = new PushTelemetry({ reporter })

    telemetry.recordSendOutcome({ ...accepted, kind: "activity", provider: "fcm" })
    telemetry.recordSendOutcome({ ...accepted, kind: "activity", provider: "fcm" })
    telemetry.recordSendOutcome({
      outcome: "unreachable",
      statusCode: 503,
      errorCode: null,
      kind: "test",
      provider: "mozilla",
    })
    telemetry.recordSuppressed("activity", "paused")
    telemetry.flush()

    expect(reporter.events).toEqual([
      {
        distinctId: "service:push",
        event: "push_send_outcomes",
        properties: {
          kind: "activity",
          outcome: "accepted",
          provider: "fcm",
          count: 2,
          window_seconds: expect.any(Number),
          $process_person_profile: false,
        },
      },
      {
        distinctId: "service:push",
        event: "push_send_outcomes",
        properties: {
          kind: "test",
          outcome: "unreachable",
          provider: "mozilla",
          count: 1,
          window_seconds: expect.any(Number),
          $process_person_profile: false,
        },
      },
      {
        distinctId: "service:push",
        event: "push_suppressed",
        properties: {
          kind: "activity",
          reason: "paused",
          count: 1,
          window_seconds: expect.any(Number),
          $process_person_profile: false,
        },
      },
    ])
  })

  it("should start a fresh window after each flush", () => {
    const reporter = new RecordingReporter()
    const telemetry = new PushTelemetry({ reporter })
    telemetry.recordSuppressed("call_ring", "no_subscriptions")
    telemetry.flush()
    telemetry.flush()
    expect(reporter.events.map((e) => e.event)).toEqual(["push_suppressed"])
  })

  it("should drop values outside the bounded label sets", () => {
    const reporter = new RecordingReporter()
    const telemetry = new PushTelemetry({ reporter })
    telemetry.recordSuppressed("usr_01ABC" as PushSendKind, "paused")
    telemetry.recordSuppressed("activity", "https://push.example.com/x" as PushSuppressionReason)
    telemetry.flush()
    expect(reporter.events).toEqual([])
  })

  it("should not throw when the reporter throws", () => {
    const telemetry = new PushTelemetry({
      reporter: {
        captureException() {},
        captureEvent() {
          throw new Error("transport down")
        },
        async shutdown() {},
      },
    })
    telemetry.recordSendOutcome({ ...accepted, kind: "activity", provider: "apple" })
    expect(() => telemetry.stop()).not.toThrow()
  })

  it("should flush the open window on stop", () => {
    const reporter = new RecordingReporter()
    const telemetry = new PushTelemetry({ reporter, flushIntervalMs: 3_600_000 })
    telemetry.start()
    telemetry.recordSendOutcome({ ...accepted, kind: "saved_reminder", provider: "windows" })
    telemetry.stop()
    expect(reporter.events.map((e) => e.properties)).toEqual([
      expect.objectContaining({ kind: "saved_reminder", outcome: "accepted", provider: "windows", count: 1 }),
    ])
  })
})
