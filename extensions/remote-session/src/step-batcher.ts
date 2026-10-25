import type { StepFrame } from "@threahq/bot-runtime-client"

const FLUSH_DELAY_MS = 500

export interface StepRecorder {
  recordSteps(invocationId: string, frames: StepFrame[], statusText?: string): Promise<unknown>
}

/** Buffers one turn's trace frames so a chatty run does not post one steps call per event; posts stay in order. */
export class StepBatcher {
  private frames: StepFrame[] = []
  /** The chip of the latest frame added; a batch carries the one current when it posts. */
  private statusText?: string
  private timer?: ReturnType<typeof setTimeout>
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly invocationId: string,
    private readonly recorder: StepRecorder
  ) {}

  add(frame: StepFrame, statusText?: string): void {
    this.push(frame, statusText)
    this.timer ??= setTimeout(() => void this.flush().catch(() => {}), FLUSH_DELAY_MS)
  }

  addNow(frame: StepFrame, statusText?: string): Promise<void> {
    this.push(frame, statusText)
    return this.flush()
  }

  private push(frame: StepFrame, statusText: string | undefined): void {
    this.frames.push(frame)
    this.statusText = statusText
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.frames.length === 0) return this.tail
    const batch = this.frames
    const { statusText } = this
    this.frames = []
    // recordSteps chunks to the wire limit and logs its own failures; a recorder that rejects fails only its own batch.
    const posted = this.tail.then(async () => {
      await this.recorder.recordSteps(this.invocationId, batch, statusText)
    })
    this.tail = posted.catch(() => {})
    return posted
  }
}
