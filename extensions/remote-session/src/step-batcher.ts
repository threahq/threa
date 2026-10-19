import type { StepFrame } from "@threahq/bot-runtime-client"

const FLUSH_DELAY_MS = 500

export interface StepRecorder {
  recordSteps(invocationId: string, frames: StepFrame[]): Promise<unknown>
}

/** Buffers one turn's trace frames so a chatty run does not post one steps call per event; posts stay in order. */
export class StepBatcher {
  private frames: StepFrame[] = []
  private timer?: ReturnType<typeof setTimeout>
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly invocationId: string,
    private readonly recorder: StepRecorder
  ) {}

  add(frame: StepFrame): void {
    this.frames.push(frame)
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
  }

  addNow(frame: StepFrame): Promise<void> {
    this.frames.push(frame)
    return this.flush()
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.frames.length === 0) return this.tail
    const batch = this.frames
    this.frames = []
    // recordSteps chunks to the wire limit and logs its own failures.
    this.tail = this.tail.then(async () => {
      await this.recorder.recordSteps(this.invocationId, batch)
    })
    return this.tail
  }
}
