import type { PolishOutcome } from "./polish"

export interface PolishSnapshot {
  revision: number
  run: (signal: AbortSignal) => Promise<PolishOutcome>
}

type ResultHandler = (snapshot: PolishSnapshot, outcome: PolishOutcome) => void

export class PolishScheduler {
  private generation = 0
  private active: { controller: AbortController; promise: Promise<void> } | null = null
  private pending: PolishSnapshot | null = null

  constructor(private readonly onResult: ResultHandler) {}

  scheduleLive(snapshot: PolishSnapshot): void {
    if (this.active) {
      this.pending = snapshot
      return
    }
    this.start(snapshot, this.generation)
  }

  async formatFinal(snapshot: PolishSnapshot): Promise<PolishOutcome> {
    this.cancel()
    const generation = this.generation
    const controller = new AbortController()
    const outcomePromise = snapshot.run(controller.signal).catch(() => ({ status: "provider_error" }) as PolishOutcome)
    const promise = outcomePromise.then(() => {})
    this.active = { controller, promise }
    const canceled = new Promise<PolishOutcome>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve({ status: "canceled" }), { once: true })
    })
    const outcome = await Promise.race([outcomePromise, canceled])
    if (this.active?.promise === promise) this.active = null
    if (generation !== this.generation || controller.signal.aborted) return { status: "canceled" }
    return outcome
  }

  cancel(): void {
    this.generation++
    this.pending = null
    this.active?.controller.abort()
    this.active = null
  }

  private start(snapshot: PolishSnapshot, generation: number): void {
    const controller = new AbortController()
    const promise = snapshot
      .run(controller.signal)
      .catch(() => ({ status: "provider_error" }) as PolishOutcome)
      .then((outcome) => {
        if (generation === this.generation && !controller.signal.aborted) this.onResult(snapshot, outcome)
      })
      .finally(() => {
        if (this.active?.promise !== promise) return
        this.active = null
        if (generation !== this.generation) return
        const pending = this.pending
        this.pending = null
        if (pending) this.start(pending, generation)
      })
    this.active = { controller, promise }
  }
}
