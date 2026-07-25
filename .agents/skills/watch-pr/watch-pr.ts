#!/usr/bin/env bun

import { $ } from "bun"
import { dirname, resolve } from "node:path"

export type Comment = {
  id: string
  kind: "issue" | "review"
  author: string
  body: string
  createdAt: string
  updatedAt: string
  url: string
  path?: string
  line?: number | null
  inReplyToId?: string | null
}

export type Check = {
  id: number
  name: string
  app: string | null
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  url: string | null
}

export type Review = {
  id: number
  author: string
  state: string
  body: string
  submittedAt: string | null
  commitId: string | null
  url: string
}

export type ReviewThread = {
  id: string
  resolved: boolean
  outdated: boolean
  path: string | null
  line: number | null
  comments: Array<{
    id: string
    author: string
    body: string
    createdAt: string
    updatedAt: string
    url: string
  }>
}

export type Snapshot = {
  capturedAt: string
  repository: string
  number: number
  title: string
  body: string
  state: string
  draft: boolean
  mergeable: boolean | null
  mergeableState: string
  headSha: string
  baseRef: string
  headRef: string
  updatedAt: string
  url: string
  comments: Comment[]
  reviews: Review[]
  reviewThreads: ReviewThread[]
  checks: Check[]
  statuses: Array<{
    id: number
    context: string
    state: string
    description: string | null
    url: string | null
    createdAt: string
    updatedAt: string
  }>
}

export type Change = {
  resource: "pull_request" | "comment" | "review" | "review_thread" | "check" | "status"
  action: "added" | "updated" | "removed"
  id: string
  before?: unknown
  after?: unknown
}

type Api = (path: string, init?: RequestInit) => Promise<unknown>

const pageSize = 100

function usage(exitCode = 2): never {
  console.error(`Usage: bun watch-pr.ts [PR_NUMBER|PR_URL] [options]

Options:
  --repo OWNER/REPO   Repository (otherwise inferred from git remote)
  --once              Print the current snapshot and exit
  --interval SECONDS  Poll interval (default: 20)
  --timeout SECONDS   Stop waiting after this duration (default: 1800; 0 = forever)
  --state PATH        Persist the last snapshot to catch changes between invocations
  --help              Show this help

Without --once, prints a baseline and waits until the first observed change. Output is NDJSON.`)
  process.exit(exitCode)
}

function parseArgs(argv: string[]) {
  let target: string | undefined
  let repo: string | undefined
  let once = false
  let interval = 20
  let timeout = 1800
  let statePath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") usage(0)
    if (arg === "--once") once = true
    else if (arg === "--repo") repo = argv[++i]
    else if (arg === "--interval") interval = Number(argv[++i])
    else if (arg === "--timeout") timeout = Number(argv[++i])
    else if (arg === "--state") statePath = argv[++i]
    else if (arg.startsWith("-")) usage()
    else if (!target) target = arg
    else usage()
  }

  if (!Number.isFinite(interval) || interval < 5) throw new Error("--interval must be at least 5 seconds")
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error("--timeout must be non-negative")
  return { target, repo, once, interval, timeout, statePath }
}

export function repositoryFromRemote(remote: string): string | undefined {
  const cleaned = remote.trim().replace(/\.git$/, "")
  const match = cleaned.match(/(?:github\.com[/:]|\/git\/)([^/]+\/[^/]+)$/)
  return match?.[1]
}

async function inferRepository(): Promise<string> {
  const remote = (await $`git remote get-url origin`.quiet().text()).trim()
  const repository = repositoryFromRemote(remote)
  if (!repository) throw new Error(`Cannot infer GitHub repository from origin: ${remote}`)
  return repository
}

async function inferPullNumber(repository: string): Promise<number> {
  const branch = (await $`git branch --show-current`.quiet().text()).trim()
  if (!branch) throw new Error("Cannot infer PR from detached HEAD; pass a PR number or URL")
  const owner = repository.split("/")[0]
  const token = await resolveToken()
  const response = (await githubFetch(
    `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=2`,
    token
  )) as Array<{ number: number }>
  if (response.length !== 1) {
    throw new Error(`Expected one open PR for ${branch}, found ${response.length}; pass a PR number or URL`)
  }
  return response[0].number
}

function pullNumberFromTarget(target: string | undefined): number | undefined {
  if (!target) return undefined
  if (/^\d+$/.test(target)) return Number(target)
  const match = target.match(/\/pull\/(\d+)(?:\/|$)/)
  if (!match) throw new Error(`Invalid PR target: ${target}`)
  return Number(match[1])
}

function repositoryFromTarget(target: string | undefined): string | undefined {
  return target?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1]
}

async function resolveToken(): Promise<string> {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const result = await $`gh auth token`.quiet().nothrow()
  const token = result.exitCode === 0 ? result.text().trim() : ""
  if (token) return token
  throw new Error("GitHub authentication missing; set GH_TOKEN/GITHUB_TOKEN or run gh auth login")
}

async function githubFetch(path: string, token: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "threa-pr-watcher",
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub ${response.status} ${path}: ${body.slice(0, 500)}`)
  }
  return response.json()
}

async function allPages(api: Api, path: string): Promise<any[]> {
  const results: any[] = []
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?"
    const batch = (await api(`${path}${separator}per_page=${pageSize}&page=${page}`)) as any[]
    results.push(...batch)
    if (batch.length < pageSize) return results
  }
}

async function allCheckRuns(api: Api, repository: string, sha: string): Promise<any[]> {
  const results: any[] = []
  for (let page = 1; ; page++) {
    const response = (await api(
      `/repos/${repository}/commits/${sha}/check-runs?per_page=${pageSize}&page=${page}`
    )) as { check_runs: any[] }
    results.push(...response.check_runs)
    if (response.check_runs.length < pageSize) return results
  }
}

async function reviewThreads(api: Api, repository: string, number: number): Promise<ReviewThread[]> {
  const [owner, name] = repository.split("/")
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line comments(first:100){nodes{id author{login} body createdAt updatedAt url}}}}}}}`
  const threads: ReviewThread[] = []
  let cursor: string | null = null
  do {
    const result = (await api("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables: { owner, name, number, cursor } }),
      headers: { "Content-Type": "application/json" },
    })) as any
    if (result.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(result.errors)}`)
    const connection = result.data.repository.pullRequest.reviewThreads
    threads.push(
      ...connection.nodes.map((thread: any) => ({
        id: thread.id,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        path: thread.path,
        line: thread.line,
        comments: thread.comments.nodes.map((comment: any) => ({
          id: comment.id,
          author: comment.author?.login ?? "ghost",
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          url: comment.url,
        })),
      }))
    )
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
  } while (cursor)
  return threads
}

export async function captureSnapshot(api: Api, repository: string, number: number): Promise<Snapshot> {
  const pull = (await api(`/repos/${repository}/pulls/${number}`)) as any
  const [issueComments, inlineComments, reviews, checks, statuses, threads] = await Promise.all([
    allPages(api, `/repos/${repository}/issues/${number}/comments`),
    allPages(api, `/repos/${repository}/pulls/${number}/comments`),
    allPages(api, `/repos/${repository}/pulls/${number}/reviews`),
    allCheckRuns(api, repository, pull.head.sha),
    allPages(api, `/repos/${repository}/commits/${pull.head.sha}/statuses`),
    reviewThreads(api, repository, number),
  ])

  const comments: Comment[] = [
    ...issueComments.map((comment: any) => ({
      id: String(comment.id),
      kind: "issue" as const,
      author: comment.user?.login ?? "ghost",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url,
    })),
    ...inlineComments.map((comment: any) => ({
      id: String(comment.id),
      kind: "review" as const,
      author: comment.user?.login ?? "ghost",
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: comment.html_url,
      path: comment.path,
      line: comment.line,
      inReplyToId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : null,
    })),
  ].sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`))

  return {
    capturedAt: new Date().toISOString(),
    repository,
    number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.state,
    draft: pull.draft,
    mergeable: pull.mergeable,
    mergeableState: pull.mergeable_state,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    updatedAt: pull.updated_at,
    url: pull.html_url,
    comments,
    reviews: reviews.map((review: any) => ({
      id: review.id,
      author: review.user?.login ?? "ghost",
      state: review.state,
      body: review.body ?? "",
      submittedAt: review.submitted_at,
      commitId: review.commit_id,
      url: review.html_url,
    })),
    reviewThreads: threads,
    checks: checks
      .map((check: any) => ({
        id: check.id,
        name: check.name,
        app: check.app?.slug ?? null,
        status: check.status,
        conclusion: check.conclusion,
        startedAt: check.started_at,
        completedAt: check.completed_at,
        url: check.details_url,
      }))
      .sort((a: Check, b: Check) => a.name.localeCompare(b.name) || a.id - b.id),
    statuses: statuses.map((status: any) => ({
      id: status.id,
      context: status.context,
      state: status.state,
      description: status.description,
      url: status.target_url,
      createdAt: status.created_at,
      updatedAt: status.updated_at,
    })),
  }
}

function comparable(value: unknown): string {
  return JSON.stringify(value, (key, item) => (key === "capturedAt" ? undefined : item))
}

function diffCollection<T>(resource: Change["resource"], before: T[], after: T[], id: (item: T) => string): Change[] {
  const oldItems = new Map(before.map((item) => [id(item), item]))
  const newItems = new Map(after.map((item) => [id(item), item]))
  const changes: Change[] = []
  for (const [itemId, item] of newItems) {
    const previous = oldItems.get(itemId)
    if (!previous) changes.push({ resource, action: "added", id: itemId, after: item })
    else if (comparable(previous) !== comparable(item))
      changes.push({ resource, action: "updated", id: itemId, before: previous, after: item })
  }
  for (const [itemId, item] of oldItems) {
    if (!newItems.has(itemId)) changes.push({ resource, action: "removed", id: itemId, before: item })
  }
  return changes
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const pullFields = [
    "title",
    "body",
    "state",
    "draft",
    "mergeable",
    "mergeableState",
    "headSha",
    "baseRef",
    "headRef",
  ] as const
  const oldPull = Object.fromEntries(pullFields.map((field) => [field, before[field]]))
  const newPull = Object.fromEntries(pullFields.map((field) => [field, after[field]]))
  const changes: Change[] =
    comparable(oldPull) === comparable(newPull)
      ? []
      : [{ resource: "pull_request", action: "updated", id: String(after.number), before: oldPull, after: newPull }]
  return changes.concat(
    diffCollection("comment", before.comments, after.comments, (item) => `${item.kind}:${item.id}`),
    diffCollection("review", before.reviews, after.reviews, (item) => String(item.id)),
    diffCollection("review_thread", before.reviewThreads, after.reviewThreads, (item) => item.id),
    diffCollection("check", before.checks, after.checks, (item) => String(item.id)),
    diffCollection("status", before.statuses, after.statuses, (item) => String(item.id))
  )
}

async function readState(path: string | undefined): Promise<Snapshot | undefined> {
  if (!path || !(await Bun.file(path).exists())) return undefined
  return Bun.file(path).json()
}

async function writeState(path: string | undefined, snapshot: Snapshot): Promise<void> {
  if (!path) return
  await Bun.$`mkdir -p ${dirname(resolve(path))}`.quiet()
  await Bun.write(path, `${JSON.stringify(snapshot, null, 2)}\n`)
}

function emit(value: unknown): void {
  console.log(JSON.stringify(value))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repository = options.repo ?? repositoryFromTarget(options.target) ?? (await inferRepository())
  const number = pullNumberFromTarget(options.target) ?? (await inferPullNumber(repository))
  const token = await resolveToken()
  const api: Api = (path, init) => githubFetch(path, token, init)
  let snapshot = await captureSnapshot(api, repository, number)
  const saved = await readState(options.statePath)

  if (options.once) {
    await writeState(options.statePath, snapshot)
    emit({ type: "snapshot", snapshot })
    return
  }

  if (saved && saved.repository === repository && saved.number === number) {
    const changes = diffSnapshots(saved, snapshot)
    if (changes.length) {
      await writeState(options.statePath, snapshot)
      emit({ type: "changes", capturedAt: snapshot.capturedAt, changes, snapshot })
      return
    }
  }

  await writeState(options.statePath, snapshot)
  emit({ type: "baseline", snapshot })
  const startedAt = Date.now()
  while (options.timeout === 0 || Date.now() - startedAt < options.timeout * 1000) {
    await Bun.sleep(options.interval * 1000)
    const next = await captureSnapshot(api, repository, number)
    const changes = diffSnapshots(snapshot, next)
    if (changes.length) {
      await writeState(options.statePath, next)
      emit({ type: "changes", capturedAt: next.capturedAt, changes, snapshot: next })
      return
    }
    snapshot = next
    await writeState(options.statePath, snapshot)
  }
  emit({ type: "timeout", capturedAt: new Date().toISOString(), snapshot })
  process.exitCode = 3
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
