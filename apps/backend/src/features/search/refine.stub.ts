import type { SearchRefinerLike, SearchRefineInput, SearchRefineResult } from "./refine"

/** Stub refiner for tests / `useStubAI`: no model, so the refine is reported as not applied (the production fail-open path). */
export class StubSearchRefiner implements SearchRefinerLike {
  async refine(_input: SearchRefineInput): Promise<SearchRefineResult | null> {
    return null
  }
}
