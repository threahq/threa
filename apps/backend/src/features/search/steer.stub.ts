import type { SearchSteererLike, SearchSteerInput, SearchSteerResult } from "./steer"

/** Stub steerer for tests / `useStubAI`: no model, so the steer is reported as not applied (the production fail-open path). */
export class StubSearchSteerer implements SearchSteererLike {
  async steer(_input: SearchSteerInput): Promise<SearchSteerResult | null> {
    return null
  }
}
