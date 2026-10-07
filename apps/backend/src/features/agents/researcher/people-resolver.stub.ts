import type { PeopleResolverLike, PersonResolution } from "./people-resolver"

/** Stub people resolver for `useStubAI`: no decision model, so it answers as an unavailable model does. */
export class StubPeopleResolver implements PeopleResolverLike {
  async resolve(): Promise<PersonResolution[] | null> {
    return null
  }
}
