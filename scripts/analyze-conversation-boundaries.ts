#!/usr/bin/env bun
/**
 * Audit conversation boundary classification quality for a given stream.
 *
 * Reads from the prod-read DB proxy (see .agents/skills/prod-db-readonly/).
 * Output is written to .tmp/conversation-boundary-audit.txt — never committed,
 * because it contains user message previews.
 *
 * Usage:
 *   bun scripts/analyze-conversation-boundaries.ts <stream_id> [user_id_a] [user_id_b]
 */

import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

const PROXY_URL = process.env.DB_READ_PROXY_URL
const PROXY_SECRET = process.env.DB_READ_PROXY_SECRET

if (!PROXY_URL || !PROXY_SECRET) {
  console.error("DB_READ_PROXY_URL and DB_READ_PROXY_SECRET must be set (see .agents/skills/prod-db-readonly).")
  process.exit(1)
}

const streamId = process.argv[2]
const userA = process.argv[3]
const userB = process.argv[4]

if (!streamId) {
  console.error("usage: bun scripts/analyze-conversation-boundaries.ts <stream_id> [user_id_a] [user_id_b]")
  process.exit(1)
}

type QueryResult = {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

async function q(sql: string, params: unknown[] = []): Promise<QueryResult> {
  const res = await fetch(`${PROXY_URL}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Secret": PROXY_SECRET!,
    },
    body: JSON.stringify({ sql, params }),
  })
  if (!res.ok) {
    throw new Error(`Query failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as QueryResult
}

function rowsToObjects<T>(r: QueryResult): T[] {
  return r.rows.map((row) => {
    const o: Record<string, unknown> = {}
    r.columns.forEach((c, i) => (o[c] = row[i]))
    return o as T
  })
}

type Conversation = {
  id: string
  stream_id: string
  message_ids: string[]
  participant_ids: string[]
  topic_summary: string | null
  completeness_score: number
  confidence: number
  status: string
  parent_conversation_id: string | null
  last_activity_at: string
  created_at: string
}

type Message = {
  id: string
  sequence: number
  author_id: string
  content_markdown: string | null
  created_at: string
}

const DOUBT_PHRASES = [
  "no clear link",
  "lacks clear link",
  "no explicit references",
  "without clear link",
  "likely a generic reaction",
  "likely continuing a new thread",
  "rather than",
  "unclear",
  "without explicit",
  "no clear linkage",
  "lacks clear context",
  "with no clear",
]

function tokens(s: string | null): Set<string> {
  if (!s) return new Set()
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9åäöéü\s]/gi, " ")
      .split(/\s+/)
      .filter((t) => t.length > 4)
  )
}

const out: string[] = []
const log = (s = "") => out.push(s)

async function main() {
  log(`# Conversation Boundary Audit`)
  log(`Stream: ${streamId}`)
  log(`Run at: ${new Date().toISOString()}`)
  log()

  const convsRes = await q(
    `SELECT c.id, c.stream_id, c.topic_summary,
            c.completeness_score, c.confidence, c.status, c.parent_conversation_id,
            c.last_activity_at, c.created_at,
            COALESCE(
              (SELECT array_agg(cma.message_id ORDER BY cma.assigned_at)
               FROM conversation_message_assignments cma
               WHERE cma.conversation_id = c.id AND cma.is_primary),
              ARRAY[]::TEXT[]
            ) AS message_ids,
            COALESCE(
              (SELECT array_agg(DISTINCT m.author_id)
               FROM conversation_message_assignments cma
               JOIN messages m ON m.id = cma.message_id
               WHERE cma.conversation_id = c.id AND cma.is_primary AND m.author_id IS NOT NULL),
              ARRAY[]::TEXT[]
            ) AS participant_ids
     FROM conversations c WHERE c.stream_id = $1 ORDER BY c.created_at ASC`,
    [streamId]
  )
  const conversations = rowsToObjects<Conversation>(convsRes)
  log(`Found ${conversations.length} conversations`)

  const totalAssigned = conversations.reduce((acc, c) => acc + (c.message_ids?.length ?? 0), 0)
  const msgCountRes = await q(`SELECT count(*)::int AS c FROM messages WHERE stream_id = $1 AND deleted_at IS NULL`, [
    streamId,
  ])
  const totalMessages = msgCountRes.rows[0][0] as number
  log(`Total messages (non-deleted): ${totalMessages}`)
  log(`Message-ids referenced by conversations: ${totalAssigned}`)

  // Cross-conv primary membership (should be impossible — partial unique index
  // on (message_id) WHERE is_primary guarantees one primary per message).
  const dupRes = await q(
    `SELECT count(*)::int FROM (
       SELECT cma.message_id
       FROM conversation_message_assignments cma
       JOIN conversations c ON c.id = cma.conversation_id
       WHERE c.stream_id = $1 AND cma.is_primary
       GROUP BY cma.message_id HAVING count(*) > 1
     ) x`,
    [streamId]
  )
  log(`Messages with >1 primary conv: ${dupRes.rows[0][0]}`)

  // Dangling refs
  const danglingRes = await q(
    `SELECT count(*) FILTER (WHERE m.id IS NULL)::int AS dangling,
            count(*) FILTER (WHERE m.deleted_at IS NOT NULL)::int AS soft_deleted
     FROM conversation_message_assignments cma
     JOIN conversations c ON c.id = cma.conversation_id
     LEFT JOIN messages m ON m.id = cma.message_id AND m.stream_id = $1
     WHERE c.stream_id = $1 AND cma.is_primary`,
    [streamId]
  )
  log(`Dangling message_id refs: ${danglingRes.rows[0][0]}`)
  log(`Soft-deleted refs: ${danglingRes.rows[0][1]}`)

  // Map message_id -> conv for surrounding-window display
  const msgIdToConv = new Map<string, Conversation>()
  for (const c of conversations) for (const mid of c.message_ids ?? []) msgIdToConv.set(mid, c)

  // Section A — doubt-expressed boundaries
  log()
  log("## A. Classifier self-flagged doubt")
  log("(topic_summary contains phrases like 'no clear link', 'rather than', 'unclear')")
  log()
  for (const c of conversations) {
    if (!c.topic_summary) continue
    const lower = c.topic_summary.toLowerCase()
    if (!DOUBT_PHRASES.some((p) => lower.includes(p))) continue
    log(
      `- ${c.id} | conf=${c.confidence.toFixed(2)} | msgs=${c.message_ids.length} | ${c.status} | ${c.created_at.slice(0, 16)}`
    )
    log(`  > ${c.topic_summary}`)
  }

  // Section B — low confidence
  log()
  log("## B. Low-confidence boundaries (confidence < 0.4)")
  log()
  const lowConf = conversations.filter((c) => c.confidence < 0.4).sort((a, b) => a.confidence - b.confidence)
  for (const c of lowConf) {
    log(
      `- ${c.id} | conf=${c.confidence.toFixed(2)} | msgs=${c.message_ids.length} | ${c.status} | ${c.created_at.slice(0, 16)}`
    )
    log(`  > ${c.topic_summary}`)
  }

  // Section C — tiny conversations (1-2 msgs) sandwiched between larger ones
  log()
  log("## C. Tiny conversations (1-2 messages)")
  log()
  const tiny = conversations.filter((c) => (c.message_ids?.length ?? 0) <= 2)
  log(`Count: ${tiny.length}`)
  for (const c of tiny) {
    log(`- ${c.id} | conf=${c.confidence.toFixed(2)} | msgs=${c.message_ids.length} | ${c.created_at.slice(0, 16)}`)
    log(`  > ${c.topic_summary}`)
  }

  // Section D — adjacent conversations with high topic overlap
  log()
  log("## D. Adjacent conversations on overlapping topics (likely bad split)")
  log()
  const byTime = [...conversations].sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (let i = 1; i < byTime.length; i++) {
    const prev = byTime[i - 1]
    const curr = byTime[i]
    const ta = tokens(prev.topic_summary)
    const tb = tokens(curr.topic_summary)
    if (ta.size === 0 || tb.size === 0) continue
    let overlap = 0
    for (const t of ta) if (tb.has(t)) overlap++
    const jacc = overlap / new Set([...ta, ...tb]).size
    const gapMin = (new Date(curr.created_at).getTime() - new Date(prev.last_activity_at).getTime()) / 60000
    if (jacc >= 0.4 && gapMin < 60) {
      log(
        `- ${prev.id} (conf=${prev.confidence.toFixed(2)}, ${prev.status}) → ${curr.id} (conf=${curr.confidence.toFixed(2)}, ${curr.status}); gap ${gapMin.toFixed(0)} min, overlap ${(jacc * 100).toFixed(0)}%`
      )
      log(`    prev: ${prev.topic_summary}`)
      log(`    curr: ${curr.topic_summary}`)
    }
  }

  // Section E — resolved status that should have stayed active
  log()
  log("## E. Resolved conversations followed by topical continuation (premature resolve)")
  log()
  for (let i = 1; i < byTime.length; i++) {
    const prev = byTime[i - 1]
    const curr = byTime[i]
    if (prev.status !== "resolved") continue
    const ta = tokens(prev.topic_summary)
    const tb = tokens(curr.topic_summary)
    if (ta.size + tb.size === 0) continue
    let overlap = 0
    for (const t of ta) if (tb.has(t)) overlap++
    const jacc = overlap / new Set([...ta, ...tb]).size
    const gapMin = (new Date(curr.created_at).getTime() - new Date(prev.last_activity_at).getTime()) / 60000
    if (jacc >= 0.3 && gapMin >= 0 && gapMin < 30) {
      log(
        `- ${prev.id} (${prev.status}) → ${curr.id}: ${gapMin.toFixed(0)} min later, ${(jacc * 100).toFixed(0)}% topic overlap`
      )
      log(`    prev: ${prev.topic_summary}`)
      log(`    curr: ${curr.topic_summary}`)
    }
  }

  // Section F — case study windows around the worst boundaries
  log()
  log("## F. Case study windows")
  log("Lines marked '>>>' belong to the conversation under inspection.")
  log("Bracket suffix shows which conv each surrounding message lives in.")
  log()
  const worst = conversations
    .filter((c) => {
      const lower = (c.topic_summary ?? "").toLowerCase()
      return c.confidence < 0.4 || DOUBT_PHRASES.some((p) => lower.includes(p))
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, 8)

  for (const c of worst) {
    log(`### ${c.id}`)
    log(`Topic: ${c.topic_summary}`)
    log(`Confidence: ${c.confidence}, status: ${c.status}, msgs: ${c.message_ids.length}`)
    const firstMid = c.message_ids[0]
    if (!firstMid) {
      log()
      continue
    }
    const firstSeqRes = await q(`SELECT sequence FROM messages WHERE id = $1`, [firstMid])
    const firstSeq = firstSeqRes.rows[0]?.[0] as number | undefined
    if (firstSeq === undefined) {
      log("(first message no longer exists)")
      log()
      continue
    }
    const windowRes = await q(
      `SELECT id, sequence, author_id, content_markdown, created_at
       FROM messages
       WHERE stream_id = $1
         AND sequence BETWEEN $2 AND $3
         AND deleted_at IS NULL
       ORDER BY sequence ASC`,
      [streamId, firstSeq - 4, firstSeq + (c.message_ids.length - 1) + 4]
    )
    const window = rowsToObjects<Message>(windowRes)
    for (const m of window) {
      const inThis = c.message_ids.includes(m.id)
      const owner = msgIdToConv.get(m.id)
      const author = m.author_id === userA ? "A" : m.author_id === userB ? "B" : m.author_id.slice(0, 8)
      const marker = inThis ? ">>>" : "   "
      const otherConv = !inThis && owner ? ` [${owner.id.slice(-6)}: ${(owner.topic_summary ?? "").slice(0, 60)}]` : ""
      const preview = (m.content_markdown ?? "").replace(/\n/g, " ").slice(0, 120)
      log(`${marker} #${m.sequence} ${author}: ${preview}${otherConv}`)
    }
    log()
  }
}

await main()

const outDir = resolve(process.cwd(), ".tmp")
mkdirSync(outDir, { recursive: true })
const outPath = resolve(outDir, "conversation-boundary-audit.txt")
await Bun.write(outPath, out.join("\n"))
console.log(`Wrote ${out.length} lines to ${outPath}`)
