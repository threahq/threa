/*
 * Post-build step: index the agent skills the site publishes.
 *
 * The skills themselves are hand-written and ship from public/ verbatim at
 * /.well-known/agent-skills/<name>/SKILL.md. Only the index is derived, because
 * the Agent Skills Discovery RFC (v0.2.0) requires a sha256 of each artifact —
 * a hand-maintained digest would go stale on the first edit. Name and
 * description come from the SKILL.md front matter, so the file stays the one
 * source of truth for both.
 *
 * Writes dist/.well-known/agent-skills/index.json.
 */

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const SITE = "https://threa.io"
const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
const dist = (p: string) => fileURLToPath(new URL(`../dist/${p}`, import.meta.url))

const SKILLS_DIR = ".well-known/agent-skills"

/* Front matter is two scalars: `name` on one line, `description` as a folded
   `>-` block. Anything else means the skill was written in a shape this index
   can't describe, so fail the build rather than publish a blank description. */
function parseFrontMatter(source: string, file: string): { name: string; description: string } {
  const block = source.match(/^---\n([\s\S]*?)\n---\n/)?.[1]
  if (!block) throw new Error(`${file}: no YAML front matter`)

  const name = block.match(/^name:\s*(\S+)\s*$/m)?.[1]
  if (!name) throw new Error(`${file}: front matter has no single-line \`name\``)

  const folded = block.match(/^description:\s*>-?\n((?:[ \t]+.*\n?)+)/m)?.[1]
  const inline = block.match(/^description:[ \t]+(\S.*)$/m)?.[1]
  const description = folded ? folded.replace(/\s+/g, " ").trim() : inline?.trim()
  if (!description) throw new Error(`${file}: front matter has no \`description\``)

  return { name, description }
}

const dirs = readdirSync(dist(SKILLS_DIR), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
if (dirs.length === 0) throw new Error(`No skills under public/${SKILLS_DIR} — nothing to index`)

const skills = dirs.map((dir) => {
  const file = `${SKILLS_DIR}/${dir}/SKILL.md`
  const source = readFileSync(dist(file), "utf8")
  const { name, description } = parseFrontMatter(source, file)
  if (name !== dir) throw new Error(`${file}: front matter name "${name}" does not match its directory "${dir}"`)

  return {
    name,
    type: "skill-md",
    description,
    url: `${SITE}/${file}`,
    digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
  }
})

writeFileSync(dist(`${SKILLS_DIR}/index.json`), `${JSON.stringify({ $schema: SCHEMA, skills }, null, 2)}\n`)

console.log(`Wrote agent-skills index (${skills.map((s) => s.name).join(", ")})`)
