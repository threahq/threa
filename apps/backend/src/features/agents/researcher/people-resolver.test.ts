import { describe, test, expect, mock } from "bun:test"
import { AISpendDeniedError, DecisionsAvailability, type AI, type DecisionQuestion } from "@threahq/agent-runtime"
import type { RosterPerson } from "../../workspaces"
import { PeopleResolver, type PeopleResolverInput } from "./people-resolver"

const ASKER = { id: "usr_asker", name: "Asker", slug: "asker" }

function person(id: string, circle: 1 | 2 | 3): RosterPerson {
  return { id, name: id, slug: id, description: null, circle }
}

const ROSTER: RosterPerson[] = [
  person("usr_kate_room", 1),
  person("usr_asker", 1),
  person("usr_kate_shared", 2),
  person("usr_kate_far", 3),
  person("usr_john_far", 3),
]

/** Per reference key, the probability each listed user gets; candidates absent from a call's criteria are dropped. */
type Beliefs = Record<string, Record<string, number>>

function createResolver(options: { beliefs?: Beliefs; pinned?: boolean; throws?: Error }) {
  const generateDecisions = mock(async (opts: { questions: Record<string, DecisionQuestion> }) => {
    if (options.throws) throw options.throws
    const answers = Object.fromEntries(
      Object.entries(opts.questions).map(([key, question]) => {
        const criteria = question.type === "choice" ? Object.keys(question.criteria) : []
        const probabilities = Object.fromEntries(
          Object.entries(options.beliefs?.[key] ?? {}).filter(([id]) => criteria.includes(id))
        )
        const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ["none"]
        return [key, { type: "choice", choice, probabilities, confidence: probabilities[choice] ?? 0.9 }]
      })
    )
    return { answers, usage: {} }
  })
  const resolver = new PeopleResolver({
    ai: { generateDecisions } as unknown as AI,
    residency: { isPinned: mock(async () => options.pinned ?? false) },
    availability: new DecisionsAvailability(),
  })
  return { resolver, generateDecisions }
}

function input(references: string[]): PeopleResolverInput {
  return {
    workspaceId: "ws_test",
    userId: ASKER.id,
    asker: ASKER,
    conversation: [],
    query: "what did Kate decide?",
    references,
    roster: ROSTER,
  }
}

const named = (id: string) => ({ id, name: id, slug: id })

describe("PeopleResolver", () => {
  test("should name the one sure match in the nearest circle, even when farther circles match too", async () => {
    const { resolver } = createResolver({
      beliefs: { ref0: { usr_kate_room: 0.8, usr_kate_shared: 0.9, usr_kate_far: 0.9 } },
    })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "resolved", person: named("usr_kate_room") },
    ])
  })

  test("should fall through to a farther circle when nearer ones have no plausible match", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_room: 0.1, usr_kate_shared: 0.7 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "resolved", person: named("usr_kate_shared") },
    ])
  })

  test("should not let an unsure near namesake hide a sure match further out", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_room: 0.3, usr_kate_shared: 0.95 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "resolved", person: named("usr_kate_shared") },
    ])
  })

  test("should report several sure matches in the nearest sure circle as ambiguous", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_far: 0.7, usr_john_far: 0.8 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "ambiguous", candidates: [named("usr_john_far"), named("usr_kate_far")] },
    ])
  })

  test("should report only unsure matches as ambiguous, most likely first", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_room: 0.3, usr_john_far: 0.5 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "ambiguous", candidates: [named("usr_john_far"), named("usr_kate_room")] },
    ])
  })

  test("should report a lone unsure match as ambiguous rather than resolved", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_room: 0.4 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "ambiguous", candidates: [named("usr_kate_room")] },
    ])
  })

  test("should resolve each reference on its own", async () => {
    const { resolver, generateDecisions } = createResolver({
      beliefs: { ref0: { usr_asker: 0.95 }, ref1: {} },
    })

    expect({
      people: await resolver.resolve(input(["me", "Bob"])),
      calls: generateDecisions.mock.calls.length,
    }).toEqual({
      people: [
        { reference: "me", status: "resolved", person: named("usr_asker") },
        { reference: "Bob", status: "unresolved" },
      ],
      calls: 3,
    })
  })

  test("should skip the decision model when there is nothing to resolve or the workspace is pinned", async () => {
    const empty = createResolver({})
    const pinned = createResolver({ pinned: true })

    expect({
      empty: await empty.resolver.resolve(input([])),
      pinned: await pinned.resolver.resolve(input(["Kate"])),
      calls: empty.generateDecisions.mock.calls.length + pinned.generateDecisions.mock.calls.length,
    }).toEqual({ empty: [], pinned: null, calls: 0 })
  })

  test("should return null when the decision model fails, and rethrow a spend denial", async () => {
    const failing = createResolver({ throws: new Error("boom") })
    const denied = createResolver({
      throws: new AISpendDeniedError({ workspaceId: "ws_test", functionId: "researcher-people" }, "workspace_limit"),
    })

    expect(await failing.resolver.resolve(input(["Kate"]))).toBeNull()
    await expect(denied.resolver.resolve(input(["Kate"]))).rejects.toBeInstanceOf(AISpendDeniedError)
  })
})
