import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { stringFlag, UsageError, type CommandSpec } from "../output"

const SKILL_NAME = "threa-cli"
// cli.ts runs from the repo checkout (no npm publish), so the skill source
// resolves relative to this file: packages/cli/src/commands → repo root.
const SKILL_SOURCE = resolve(import.meta.dir, "../../../..", ".agents/skills", SKILL_NAME, "SKILL.md")

export const skillCommand: CommandSpec = {
  name: "skill",
  usage: "threa skill install [--target dir] | threa skill print",
  summary: "Install the threa-cli agent skill into ~/.claude/skills, or print it",
  help:
    "threa skill install [flags]\n" +
    "threa skill print\n\n" +
    "install copies the threa-cli skill (how an agent uses this CLI well) into the global Claude Code\n" +
    "skills directory so every session on this machine can load it, in any project.\n" +
    "print writes the skill markdown to stdout — pipe it wherever a skills directory is not the target.\n\n" +
    "Flags:\n" +
    "  --target dir   install: destination skills directory (default ~/.claude/skills)\n" +
    "  --help         show this help",
  options: {
    target: { type: "string" },
  },
  run: async (_ctx, positionals, values) => {
    const sub = positionals[0]
    if (sub !== "install" && sub !== "print") {
      throw new UsageError(`skill supports two subcommands: install, print (got "${sub ?? ""}")`)
    }
    if (!existsSync(SKILL_SOURCE)) {
      throw new UsageError(
        `Skill source not found at ${SKILL_SOURCE}. Run threa from a Threa repo checkout (the skill ships in .agents/skills/${SKILL_NAME}).`
      )
    }
    if (sub === "print") {
      return { skill: SKILL_NAME, source: SKILL_SOURCE, content: readFileSync(SKILL_SOURCE, "utf8") }
    }
    const targetRoot = stringFlag(values, "target") ?? join(homedir(), ".claude", "skills")
    const destination = join(targetRoot, SKILL_NAME, "SKILL.md")
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(SKILL_SOURCE, destination)
    return { installed: true, skill: SKILL_NAME, source: SKILL_SOURCE, destination }
  },
  render: (payload) => {
    const p = payload as { destination?: string; content?: string }
    if (typeof p.content === "string") return p.content
    return `installed ${SKILL_NAME} → ${p.destination ?? "?"}\nRe-run after pulling a newer checkout to refresh it.`
  },
  noConfig: true,
}
