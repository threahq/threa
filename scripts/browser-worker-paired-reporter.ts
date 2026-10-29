import { appendFileSync } from "node:fs"
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from "@playwright/test/reporter"

function record(value: object) {
  appendFileSync(process.env.PAIRED_STEPS_FILE!, `${JSON.stringify({ at: Date.now(), ...value })}\n`)
}

function stepData(step: TestStep): object {
  return {
    title: step.title,
    category: step.category,
    start: step.startTime.getTime(),
    duration: step.duration,
    error: step.error,
    steps: step.steps.map(stepData),
  }
}

export default class PairedReporter implements Reporter {
  onBegin(_config: FullConfig, suite: Suite) {
    record({ event: "begin", inventory: suite.allTests().map((test) => ({ id: test.id, title: test.titlePath() })) })
  }
  onTestBegin(test: TestCase) {
    record({ event: "testBegin", id: test.id })
  }
  onTestEnd(test: TestCase, result: TestResult) {
    record({ event: "testEnd", id: test.id, status: result.status, steps: result.steps.map(stepData) })
  }
  onEnd(result: FullResult) {
    record({ event: "end", status: result.status })
  }
}
