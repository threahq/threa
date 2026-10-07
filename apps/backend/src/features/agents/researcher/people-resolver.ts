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

const CIRCLES = [1, 2, 3] as const

/**
 * Matches the people a research query names to workspace users with the decision model, nearest circle
 * first: a sure match in the room or the asker's own streams beats any namesake further out, and
 * several sure matches in one circle, or only unsure ones anywhere, come back as ambiguous. Every
 * circle is asked at once and read nearest-first, so resolution costs one round trip. Returns null when
 * the decision model is not available to this workspace or did not answer in time.
 */
export class PeopleResolver {
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
      const picksByCircle = await Promise.all(
        CIRCLES.map(async (circle) => {
          const chunks = chunk(
            input.roster.filter((person) => person.circle === circle),
            PEOPLE_RESOLVER_CHUNK_SIZE
          )
          const results = await Promise.all(chunks.map((people) => this.ask(input, people, composed.signal)))
          return input.references.map((_, index) =>
            results.flatMap((result, chunkIndex) => picks(result, referenceKey(index), chunks[chunkIndex]!))
          )
        })
      )
      return input.references.map((reference, index) =>
        readResolution(
          reference,
          picksByCircle.map((circle) => circle[index]!)
        )
      )
    } catch (error) {
      if (error instanceof AISpendDeniedError) throw error
      if (isAbortError(error)) {
        logger.debug({ workspaceId: input.workspaceId }, "People resolver timed out or was aborted; people unresolved")
        return null
      }
      this.availability.recordFailure(error)
      logger.warn({ error, workspaceId: input.workspaceId }, "People resolver failed; people unresolved")
      return null
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
      probability: answer.probabilities[person.id] ?? (answer.choice === person.id ? answer.confidence : 0),
    }))
    .filter((pick) => pick.probability >= PEOPLE_PLAUSIBLE_AT)
}

/**
 * The nearest circle with a sure pick decides: one sure pick names the person, several are ambiguous. Plausible
 * picks short of sure only matter when no circle is sure, so a weak near namesake never hides a sure match further out.
 */
function readResolution(reference: string, circles: Pick[][]): PersonResolution {
  for (const circle of circles) {
    const sure = circle.filter((pick) => pick.probability >= PEOPLE_RESOLVED_AT)
    if (sure.length === 1) return { reference, status: "resolved", person: sure[0]!.person }
    if (sure.length > 1) return ambiguous(reference, sure)
  }
  const plausible = circles.flat()
  return plausible.length > 0 ? ambiguous(reference, plausible) : { reference, status: "unresolved" }
}

function ambiguous(reference: string, picks: Pick[]): PersonResolution {
  return {
    reference,
    status: "ambiguous",
    candidates: [...picks].sort((a, b) => b.probability - a.probability).map((pick) => pick.person),
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
