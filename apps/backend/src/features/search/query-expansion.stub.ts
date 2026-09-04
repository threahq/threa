import type { QueryExpanderLike, QueryExpansionContext } from "./query-expansion"

/**
 * Stub query expander for tests / `useStubAI`: no variants (no model call),
 * which is exactly the production fail-open behaviour.
 */
export class StubQueryExpander implements QueryExpanderLike {
  async expand(_query: string, _context: QueryExpansionContext): Promise<string[]> {
    return []
  }
}
