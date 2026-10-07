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

function createResolver(options: {
  beliefs?: Beliefs
  pinned?: boolean
  throws?: Error
  /** Calls listing this user fail; the others answer. */
  failsFor?: string
  sparseChoice?: string
}) {
  const generateDecisions = mock(async (opts: { questions: Record<string, DecisionQuestion> }) => {
    if (options.throws) throw options.throws
    const question = Object.values(opts.questions)[0]
    if (options.failsFor && question?.type === "choice" && options.failsFor in question.criteria) {
      throw new Error("provider unavailable")
    }
    const answers = Object.fromEntries(
      Object.entries(opts.questions).map(([key, question]) => {
        const criteria = question.type === "choice" ? Object.keys(question.criteria) : []
        const probabilities = Object.fromEntries(
          Object.entries(options.beliefs?.[key] ?? {}).filter(([id]) => criteria.includes(id))
        )
        const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? [
          options.sparseChoice ?? "none",
        ]
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

  test("should report an unsure near namesake as ambiguous rather than pick a sure match further out", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_room: 0.3, usr_kate_shared: 0.95 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "ambiguous", candidates: [named("usr_kate_room"), named("usr_kate_shared")] },
    ])
  })

  test("should report two unsure namesakes in the room as ambiguous alongside a sure one further out", async () => {
    const roster = [person("usr_kate_a", 1), person("usr_kate_b", 1), person("usr_kate_far", 3)]
    const { resolver } = createResolver({
      beliefs: { ref0: { usr_kate_a: 0.45, usr_kate_b: 0.45, usr_kate_far: 0.9 } },
    })

    expect(await resolver.resolve({ ...input(["Kate"]), roster })).toEqual([
      {
        reference: "Kate",
        status: "ambiguous",
        candidates: [named("usr_kate_a"), named("usr_kate_b"), named("usr_kate_far")],
      },
    ])
  })

  test("should report several sure matches in the nearest circle with a match as ambiguous", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_far: 0.7, usr_john_far: 0.8 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "ambiguous", candidates: [named("usr_john_far"), named("usr_kate_far")] },
    ])
  })

  test("should report only unsure matches as ambiguous, nearest circle first", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_room: 0.3, usr_john_far: 0.5 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "ambiguous", candidates: [named("usr_kate_room"), named("usr_john_far")] },
    ])
  })

  test("should keep the near namesakes that made a reference ambiguous when farther matches would fill the list", async () => {
    const roster = [
      person("usr_kate_a", 1),
      person("usr_kate_b", 1),
      ...[0, 1, 2, 3, 4].map((i) => person(`usr_kate_far_${i}`, 3)),
    ]
    const { resolver } = createResolver({
      beliefs: {
        ref0: {
          usr_kate_a: 0.3,
          usr_kate_b: 0.35,
          ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`usr_kate_far_${i}`, 0.9])),
        },
      },
    })

    expect(await resolver.resolve({ ...input(["Kate"]), roster })).toEqual([
      {
        reference: "Kate",
        status: "ambiguous",
        candidates: [named("usr_kate_b"), named("usr_kate_a"), ...[0, 1, 2].map((i) => named(`usr_kate_far_${i}`))],
      },
    ])
  })

  test("should report a lone unsure match as ambiguous rather than resolved", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: { usr_kate_room: 0.4 } } })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([
      { reference: "Kate", status: "ambiguous", candidates: [named("usr_kate_room")] },
    ])
  })

  test("should list at most the five most likely candidates for an ambiguous reference", async () => {
    const kates = Array.from({ length: 7 }, (_, i) => person(`usr_kate_${i}`, 3))
    const { resolver } = createResolver({
      beliefs: { ref0: Object.fromEntries(kates.map((kate, i) => [kate.id, 0.3 + i * 0.01])) },
    })

    expect(await resolver.resolve({ ...input(["Kate"]), roster: kates })).toEqual([
      {
        reference: "Kate",
        status: "ambiguous",
        candidates: [6, 5, 4, 3, 2].map((i) => named(`usr_kate_${i}`)),
      },
    ])
  })

  test("should leave a choice with no probability of its own unresolved, whatever the answer's confidence", async () => {
    const { resolver } = createResolver({ beliefs: { ref0: {} }, sparseChoice: "usr_kate_room" })

    expect(await resolver.resolve(input(["Kate"]))).toEqual([{ reference: "Kate", status: "unresolved" }])
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

  test("should leave a reference unresolved when a circle nearer than any match failed, and resolve past a farther failure", async () => {
    const nearFailed = createResolver({ beliefs: { ref0: { usr_kate_shared: 0.9 } }, failsFor: "usr_kate_room" })
    const farFailed = createResolver({ beliefs: { ref0: { usr_kate_room: 0.9 } }, failsFor: "usr_kate_far" })

    expect({
      nearFailed: await nearFailed.resolver.resolve(input(["Kate"])),
      farFailed: await farFailed.resolver.resolve(input(["Kate"])),
    }).toEqual({
      nearFailed: [{ reference: "Kate", status: "unresolved" }],
      farFailed: [{ reference: "Kate", status: "resolved", person: named("usr_kate_room") }],
    })
  })

  test("should return null when every decision call fails, nothing once the caller aborts, and rethrow a spend denial", async () => {
    const failing = createResolver({ throws: new Error("boom") })
    const aborted = createResolver({ throws: new DOMException("aborted", "AbortError") })
    const controller = new AbortController()
    controller.abort()
    const denied = createResolver({
      throws: new AISpendDeniedError({ workspaceId: "ws_test", functionId: "researcher-people" }, "workspace_limit"),
    })

    expect(await failing.resolver.resolve(input(["Kate"]))).toBeNull()
    expect(await aborted.resolver.resolve({ ...input(["Kate"]), signal: controller.signal })).toEqual([])
    await expect(denied.resolver.resolve(input(["Kate"]))).rejects.toBeInstanceOf(AISpendDeniedError)
  })
})
