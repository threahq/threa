import { normalizeUrl } from "../link-previews"

interface DeriveInput {
  eventType: string
  repositoryFullName: string | null
  payload: Record<string, unknown>
}

/** A GitHub `owner/repo` full name — exactly one slash, no whitespace. */
function isRepoFullName(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value)
}

/** Pull a positive integer out of an unknown JSON value. */
function toPositiveInt(value: unknown): number | null {
  let n = NaN
  if (typeof value === "number") n = value
  else if (typeof value === "string") n = Number.parseInt(value, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

function readNumber(container: unknown, key: string): number | null {
  if (container === null || typeof container !== "object") return null
  return toPositiveInt((container as Record<string, unknown>)[key])
}

/**
 * Canonical, normalized PR/issue URLs a webhook delivery invalidates. Built from
 * the repository full name plus the number in the payload, then run through the
 * SAME `normalizeUrl` used at ingestion so matching against stored
 * `link_previews.normalized_url` is exact. Diff/comment anchor variants are not
 * derived here — they share this base URL and are matched by prefix downstream
 * (`findGithubPreviewMatches`). Returns [] for events with no derivable target.
 */
export function deriveGithubTargetUrls(input: DeriveInput): string[] {
  if (!input.repositoryFullName || !isRepoFullName(input.repositoryFullName)) return []
  const repo = input.repositoryFullName

  switch (input.eventType) {
    case "pull_request":
    case "pull_request_review": {
      const number = readNumber(input.payload.pull_request, "number") ?? toPositiveInt(input.payload.number)
      if (!number) return []
      return [normalizeUrl(`https://github.com/${repo}/pull/${number}`)]
    }
    case "issues": {
      const number = readNumber(input.payload.issue, "number") ?? toPositiveInt(input.payload.number)
      if (!number) return []
      return [normalizeUrl(`https://github.com/${repo}/issues/${number}`)]
    }
    default:
      return []
  }
}
