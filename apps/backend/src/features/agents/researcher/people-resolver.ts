import {
  AISpendDeniedError,
  choiceAnswer,
  composeAbortSignal,
  isAbortError,
  type AI,
  type DecisionQuestion,
  type DecisionsAvailability,
  type DecisionsResult,
} from "@threahq/agent-runtime"
import type { AIResidencyPolicy } from "../../ai-usage"
import type { RosterPerson } from "../../workspaces"
import { logger } from "../../../lib/logger"
import {
  PEOPLE_NONE_CHOICE,
  PEOPLE_PLAUSIBLE_AT,
  PEOPLE_RESOLVED_AT,
  PEOPLE_RESOLVER_CHUNK_SIZE,
  PEOPLE_RESOLVER_MODEL_ID,
  PEOPLE_RESOLVER_TIMEOUT_MS,
  PEOPLE_MAX_CANDIDATES,
  peopleReferenceQuestion,
} from "./config"

export interface ResolvedPerson {
  id: string
  name: string
  slug: string
}

export type PersonResolution =
  | { reference: string; status: "resolved"; person: ResolvedPerson }
  | { reference: string; status: "ambiguous"; candidates: ResolvedPerson[] }
  | { reference: string; status: "unresolved" }

export interface PeopleResolverInput {
  workspaceId: string
  userId: string
  asker: ResolvedPerson
  conversation: { author: string; text: string }[]
  query: string
  /** The people the query refers to, as written: "Kate", "my manager", "me". */
  references: string[]
  roster: RosterPerson[]
  signal?: AbortSignal
}

export interface PeopleResolverLike {
  resolve(input: PeopleResolverInput): Promise<PersonResolution[] | null>
}

const CIRCLES = [1, 2, 3] as const

/**
 * Matches the people a research query names to workspace users with the decision model, nearest circle
 * first: the nearest circle with a plausible match decides, so a namesake further out never wins over
 * someone in the room or the asker's own streams. Every circle is asked at once and read nearest-first,
 * so resolution costs one round trip. Returns null when the decision model is not available to this
 * workspace or no call answered in time.
 */
export class PeopleResolver implements PeopleResolverLike {
  private readonly ai: AI
  private readonly residency: AIResidencyPolicy
  private readonly availability: DecisionsAvailability

  constructor(deps: { ai: AI; residency: AIResidencyPolicy; availability: DecisionsAvailability }) {
    this.ai = deps.ai
    this.residency = deps.residency
    this.availability = deps.availability
  }

  async resolve(input: PeopleResolverInput): Promise<PersonResolution[] | null> {
    if (input.references.length === 0) return []
    if ((await this.residency.isPinned(input.workspaceId)) || !this.availability.isAvailable) return null

    const composed = composeAbortSignal({
      parent: input.signal,
      timeoutMs: PEOPLE_RESOLVER_TIMEOUT_MS,
      timeoutReason: "people resolver timeout",
    })
    try {
      const chunksByCircle = CIRCLES.map((circle) =>
        chunk(
          input.roster.filter((person) => person.circle === circle),
          PEOPLE_RESOLVER_CHUNK_SIZE
        )
      )
      const settled = await Promise.all(
        chunksByCircle.map((chunks) =>
          Promise.allSettled(chunks.map((people) => this.ask(input, people, composed.signal)))
        )
      )
      const failures = settled.flat().flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      const spendDenied = failures.find((error) => error instanceof AISpendDeniedError)
      if (spendDenied) throw spendDenied
      if (failures.length > 0) {
        if (input.signal?.aborted) return null
        const failure = failures.find((error) => !isAbortError(error))
        if (failures.length === settled.flat().length) {
          if (failure) {
            this.availability.recordFailure(failure)
            logger.warn({ error: failure, workspaceId: input.workspaceId }, "People resolver failed; people unresolved")
          } else {
            logger.warn(
              { workspaceId: input.workspaceId, timeoutMs: PEOPLE_RESOLVER_TIMEOUT_MS },
              "People resolver timed out; people unresolved"
            )
          }
          return null
        }
        logger.warn(
          { error: failure, workspaceId: input.workspaceId, failedCalls: failures.length },
          "People resolver calls failed; their circles count as unknown"
        )
      }

      return input.references.map((reference, index) =>
        readResolution(
          reference,
          settled.map((results, circleIndex) =>
            results.every((result) => result.status === "fulfilled")
              ? results.flatMap((result, chunkIndex) =>
                  picks(result.value, referenceKey(index), chunksByCircle[circleIndex]![chunkIndex]!)
                )
              : null
          )
        )
      )
    } finally {
      composed.cleanup()
    }
  }

  private ask(input: PeopleResolverInput, people: RosterPerson[], signal: AbortSignal): Promise<DecisionsResult> {
    const criteria: Record<string, string> = Object.fromEntries(people.map((person) => [person.id, describe(person)]))
    criteria[PEOPLE_NONE_CHOICE] = "None of these people"
    const questions: Record<string, DecisionQuestion> = Object.fromEntries(
      input.references.map((reference, index) => [
        referenceKey(index),
        { type: "choice", instructions: peopleReferenceQuestion(reference), criteria },
      ])
    )
    return this.ai.generateDecisions({
      model: PEOPLE_RESOLVER_MODEL_ID,
      state: {
        asker: `${input.asker.name} (@${input.asker.slug})`,
        conversation: input.conversation,
        query: input.query,
      },
      questions,
      abortSignal: signal,
      telemetry: {
        functionId: "researcher-people",
        metadata: { referenceCount: input.references.length, candidateCount: people.length },
      },
      context: { workspaceId: input.workspaceId, userId: input.userId, origin: "system" },
    })
  }
}

interface Pick {
  person: ResolvedPerson
  probability: number
}

function picks(result: DecisionsResult, key: string, people: RosterPerson[]): Pick[] {
  const answer = choiceAnswer(result, key)
  return people
    .map((person) => ({
      person: { id: person.id, name: person.name, slug: person.slug },
      probability: answer.probabilities[person.id] ?? 0,
    }))
    .filter((pick) => pick.probability >= PEOPLE_PLAUSIBLE_AT)
}

/**
 * The nearest circle with a plausible pick decides: exactly one sure pick there names the person; anything else is
 * ambiguous over that circle and every circle beyond it, so a farther sure match is offered but never chosen over a
 * nearer namesake. A circle whose calls failed (null) is unknown, and reaching it leaves the reference unresolved.
 */
function readResolution(reference: string, circles: (Pick[] | null)[]): PersonResolution {
  for (const [index, circle] of circles.entries()) {
    if (circle === null) return { reference, status: "unresolved" }
    if (circle.length === 0) continue
    const sure = circle.filter((pick) => pick.probability >= PEOPLE_RESOLVED_AT)
    if (sure.length === 1) return { reference, status: "resolved", person: sure[0]!.person }
    return ambiguous(
      reference,
      circles.slice(index).flatMap((later) => later ?? [])
    )
  }
  return { reference, status: "unresolved" }
}

function ambiguous(reference: string, picks: Pick[]): PersonResolution {
  return {
    reference,
    status: "ambiguous",
    candidates: [...picks]
      .sort((a, b) => b.probability - a.probability)
      .slice(0, PEOPLE_MAX_CANDIDATES)
      .map((pick) => pick.person),
  }
}

function describe(person: RosterPerson): string {
  const label = `${person.name} (@${person.slug})`
  return person.description ? `${label}: ${person.description}` : label
}

function referenceKey(index: number): string {
  return `ref${index}`
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}
