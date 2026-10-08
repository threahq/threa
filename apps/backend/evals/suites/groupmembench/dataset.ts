/**
 * GroupMemBench (github.com/UCSB-NLP-Chang/GroupMemBench) loader. The dataset is not
 * vendored (it states no license): clone it into `.tmp/bench/GroupMemBench`
 * at the repo root, or point `GROUPMEMBENCH_DIR` at a checkout.
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

export const QUESTION_TYPES = [
  "abstention",
  "knowledge_update",
  "multi_hop",
  "temporal",
  "term_ambiguity",
  "user_implicit",
] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export interface BenchMessage {
  node: string
  author: string
  content: string
  createdAt: Date
  replyTo: string | null
  topic: string
  phase: string
}

/** A top-level post and every message under it, nested replies flattened, oldest first. */
export interface BenchThread {
  root: BenchMessage
  replies: BenchMessage[]
}

export interface BenchChannel {
  name: string
  /** Top-level posts, oldest first. */
  posts: BenchMessage[]
  threads: BenchThread[]
  authors: string[]
}

export interface BenchQuestion {
  id: string
  type: QuestionType
  question: string
  answer: string
  askingUser: string
}

interface RawMessage {
  msg_node: string
  author: string
  content: string
  timestamp: string
  reply_to: string | null
  topic: string
  phase_name: string
}

interface RawQuestion {
  id: string
  question: string
  answer: string
  asking_user_id: string
}

const DOMAIN = "Technology"

export function datasetDir(): string {
  const dir = process.env.GROUPMEMBENCH_DIR ?? resolve(import.meta.dir, "../../../../../.tmp/bench/GroupMemBench")
  if (!existsSync(join(dir, "questions", DOMAIN))) {
    throw new Error(
      `GroupMemBench not found at ${dir}: git clone --depth 1 https://github.com/UCSB-NLP-Chang/GroupMemBench .tmp/bench/GroupMemBench (or set GROUPMEMBENCH_DIR)`
    )
  }
  return dir
}

const byTime = (a: BenchMessage, b: BenchMessage) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.node.localeCompare(b.node)

export function buildChannel(name: string, raw: RawMessage[]): BenchChannel {
  const messages = raw.map(
    (m): BenchMessage => ({
      node: m.msg_node,
      author: m.author,
      content: m.content,
      // The dataset's timestamps carry no zone; read them as UTC so temporal answers keep their dates.
      createdAt: new Date(`${m.timestamp}Z`),
      replyTo: m.reply_to,
      topic: m.topic,
      phase: m.phase_name,
    })
  )
  const byNode = new Map(messages.map((m) => [m.node, m]))
  const rootOf = (message: BenchMessage): BenchMessage => {
    let current = message
    while (current.replyTo !== null) {
      const parent = byNode.get(current.replyTo)
      if (!parent) throw new Error(`${name}: ${current.node} replies to unknown ${current.replyTo}`)
      current = parent
    }
    return current
  }

  const repliesByRoot = Map.groupBy(
    messages.filter((m) => m.replyTo !== null),
    (m) => rootOf(m).node
  )
  // Some roots are stamped after their own replies, up to nine days. A thread
  // cannot open before its root exists, so such a root is posted with its first reply.
  const posts = messages
    .filter((m) => m.replyTo === null)
    .map((root) => {
      const first = repliesByRoot.get(root.node)?.sort(byTime)[0]
      return first && first.createdAt < root.createdAt ? { ...root, createdAt: first.createdAt } : root
    })
    .sort(byTime)
  return {
    name,
    posts,
    threads: posts.flatMap((root) => {
      const replies = repliesByRoot.get(root.node)
      return replies ? [{ root, replies }] : []
    }),
    authors: [...new Set(messages.map((m) => m.author))].sort(),
  }
}

export function loadChannels(dir: string): BenchChannel[] {
  const file = join(dir, "data", "final", DOMAIN, `synthetic_domain_channels_rolevariants_${DOMAIN}.json`)
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, RawMessage[]>
  return Object.entries(raw).map(([name, messages]) => buildChannel(name, messages))
}

export function loadQuestions(dir: string): BenchQuestion[] {
  return QUESTION_TYPES.flatMap((type) =>
    readFileSync(join(dir, "questions", DOMAIN, `${type}.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const q = JSON.parse(line) as RawQuestion
        return { id: q.id, type, question: q.question, answer: q.answer, askingUser: q.asking_user_id }
      })
  )
}
