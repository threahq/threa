import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hermesInstall } from "./config"
import { parseArgs, renderSystemdUnit, runInstall } from "./install"

const PACKAGE_DIR = join(import.meta.dir, "..")

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hermes-install-"))
}

function installOptions(homeDir: string, profile?: string) {
  return {
    install: hermesInstall({ homeDir, ...(profile === undefined ? {} : { profile }) }),
    packageDir: PACKAGE_DIR,
    entryPath: join(PACKAGE_DIR, "src", "index.ts"),
    runtimePath: "/home/u/.bun/bin/bun",
    dryRun: true,
  }
}

const SERVICE_NAME = "threa-hermes-remote.service"

describe("renderSystemdUnit", () => {
  test("renders the connector unit with absolute paths and appended logs", () => {
    expect(
      renderSystemdUnit({
        runtimePath: "/home/u/.bun/bin/bun",
        entryPath: "/srv/threa/extensions/hermes-remote/src/index.ts",
        packageDir: "/srv/threa/extensions/hermes-remote",
        logDir: "/home/u/.threa/hermes-remote/log",
        envFile: "/home/u/.config/threa/hermes-remote.env",
      })
    ).toEqual(
      [
        "[Unit]",
        "Description=Threa Hermes connector",
        "After=network-online.target hermes-gateway.service",
        "Wants=hermes-gateway.service",
        "",
        "[Service]",
        "Type=simple",
        "Environment=PATH=/home/u/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        "EnvironmentFile=-/home/u/.config/threa/hermes-remote.env",
        "WorkingDirectory=/srv/threa/extensions/hermes-remote",
        "ExecStart=/home/u/.bun/bin/bun /srv/threa/extensions/hermes-remote/src/index.ts",
        "Restart=always",
        "RestartSec=10",
        "StandardOutput=append:/home/u/.threa/hermes-remote/log/connector.log",
        "StandardError=append:/home/u/.threa/hermes-remote/log/connector.error.log",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n")
    )
  })

  test("a profile names the unit's identity, after the env file so it cannot be repointed", () => {
    const lines = renderSystemdUnit({
      runtimePath: "/home/u/.bun/bin/bun",
      entryPath: "/srv/threa/extensions/hermes-remote/src/index.ts",
      packageDir: "/srv/threa/extensions/hermes-remote",
      logDir: "/home/u/.threa/hermes-muse/log",
      envFile: "/home/u/.config/threa/hermes-muse.env",
      profile: "muse",
    }).split("\n")

    expect({
      description: lines[1],
      afterEnvFile:
        lines.indexOf("Environment=THREA_HERMES_PROFILE=muse") >
        lines.indexOf("EnvironmentFile=-/home/u/.config/threa/hermes-muse.env"),
      log: lines.find((line) => line.startsWith("StandardOutput=")),
    }).toEqual({
      description: "Description=Threa Hermes connector (muse)",
      afterEnvFile: true,
      log: "StandardOutput=append:/home/u/.threa/hermes-muse/log/connector.log",
    })
  })
})

describe("renderSystemdUnit paths", () => {
  test("a path systemd would split or unescape is refused", () => {
    expect(() =>
      renderSystemdUnit({
        runtimePath: "/home/u/.bun/bin/bun",
        entryPath: "/home/my user/threa/extensions/hermes-remote/src/index.ts",
        packageDir: "/home/my user/threa/extensions/hermes-remote",
        logDir: "/home/my user/.threa/hermes-remote/log",
        envFile: "/home/my user/.config/threa/hermes-remote.env",
      })
    ).toThrow("whitespace and backslashes")
  })
})

describe("parseArgs", () => {
  test("reads a profile from either spelling and rejects anything else", () => {
    expect({
      bare: parseArgs([]),
      spaced: parseArgs(["--profile", "muse", "--start"]),
      equals: parseArgs(["--profile=muse", "--force", "--dry-run"]),
      missingValue: (() => {
        try {
          parseArgs(["--profile", "--start"])
        } catch (error) {
          return (error as Error).message
        }
        return "no error"
      })(),
      unknown: (() => {
        try {
          parseArgs(["--name", "muse"])
        } catch (error) {
          return (error as Error).message
        }
        return "no error"
      })(),
    }).toEqual({
      bare: { force: false, start: false, dryRun: false },
      spaced: { profile: "muse", force: false, start: true, dryRun: false },
      equals: { profile: "muse", force: true, start: false, dryRun: true },
      missingValue:
        "--profile needs a Hermes profile name. Usage: threa-hermes-install [--profile <name>] [--force] [--start] [--dry-run]",
      unknown:
        "Unknown argument --name. Usage: threa-hermes-install [--profile <name>] [--force] [--start] [--dry-run]",
    })
  })
})

describe("runInstall", () => {
  function racingInstall(home: string, appears: string, content: string) {
    const log = (message: string) => {
      if (message === `writing ${join(home, ".config", "systemd", "user", SERVICE_NAME)}`)
        writeFileSync(appears, content)
    }
    return () => runInstall({ ...installOptions(home), dryRun: false, run: () => ({ status: 0 }), log })
  }

  test("a unit that appears after planning is not overwritten", () => {
    const home = tempHome()
    const unitPath = join(home, ".config", "systemd", "user", SERVICE_NAME)

    expect(racingInstall(home, unitPath, "theirs\n")).toThrow(
      `${unitPath} already exists. Pass --force to overwrite it.`
    )
    expect(readFileSync(unitPath, "utf8")).toBe("theirs\n")
  })

  test("a SOUL.md that appears after planning is kept", () => {
    const home = tempHome()
    const soulPath = join(home, ".hermes", "SOUL.md")

    racingInstall(home, soulPath, "mine\n")()
    expect(readFileSync(soulPath, "utf8")).toBe("mine\n")
  })

  test("a profile Hermes does not know is refused before anything is written", () => {
    const home = tempHome()

    expect(() => runInstall({ ...installOptions(home, "muse"), dryRun: false, run: () => ({ status: 0 }) })).toThrow(
      `Hermes profile "muse" has no home at ${join(home, ".hermes", "profiles", "muse")}. ` +
        "Create it first: hermes profile create muse"
    )
    expect(existsSync(join(home, ".config"))).toBe(false)
  })

  test("a named profile installs beside the default one, sharing no path", () => {
    const home = tempHome()
    mkdirSync(join(home, ".hermes", "profiles", "muse"), { recursive: true })
    const run = () => ({ status: 0 })

    runInstall({ ...installOptions(home), dryRun: false, run })
    runInstall({ ...installOptions(home, "muse"), dryRun: false, run })

    const unitPath = join(home, ".config", "systemd", "user", "threa-hermes-muse.service")
    expect({
      unit: readFileSync(unitPath, "utf8").includes("Environment=THREA_HERMES_PROFILE=muse"),
      skill: readFileSync(join(home, ".hermes", "profiles", "muse", "skills", "threa", "SKILL.md"), "utf8").includes(
        "~/.threa/hermes-muse/work"
      ),
      skillNamesNoOtherInstall: !readFileSync(
        join(home, ".hermes", "profiles", "muse", "skills", "threa", "SKILL.md"),
        "utf8"
      ).includes("hermes-remote"),
      soul: existsSync(join(home, ".hermes", "profiles", "muse", "SOUL.md")),
      log: existsSync(join(home, ".threa", "hermes-muse", "log")),
      defaultUntouched: readFileSync(join(home, ".config", "systemd", "user", SERVICE_NAME), "utf8").includes(
        "THREA_HERMES_PROFILE"
      ),
    }).toEqual({
      unit: true,
      skill: true,
      skillNamesNoOtherInstall: true,
      soul: true,
      log: true,
      defaultUntouched: false,
    })
  })
})

describe("runInstall --dry-run", () => {
  test("plans the unit, the log directory, the skill and the persona, and touches nothing", () => {
    const home = tempHome()
    const logs: string[] = []
    const plan = runInstall({ ...installOptions(home), start: true, log: (message) => logs.push(message) })

    expect({
      unitPath: plan.unitPath,
      directories: plan.directories,
      writes: plan.writes,
      commands: plan.commands,
      wroteAnything: existsSync(join(home, ".config")) || existsSync(join(home, ".hermes")),
      ranAnything: logs.some((line) => line.startsWith("running ")),
    }).toEqual({
      unitPath: join(home, ".config", "systemd", "user", SERVICE_NAME),
      directories: [
        join(home, ".config", "systemd", "user"),
        join(home, ".threa", "hermes-remote", "log"),
        join(home, ".hermes", "skills", "threa"),
      ],
      writes: [
        { path: join(home, ".config", "systemd", "user", SERVICE_NAME) },
        { path: join(home, ".hermes", "skills", "threa", "SKILL.md") },
        { path: join(home, ".hermes", "SOUL.md") },
      ],
      commands: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", SERVICE_NAME],
        ["systemctl", "--user", "restart", SERVICE_NAME],
      ],
      wroteAnything: false,
      ranAnything: false,
    })
  })

  test("an existing SOUL.md is kept, never overwritten", () => {
    const home = tempHome()
    mkdirSync(join(home, ".hermes"), { recursive: true })
    writeFileSync(join(home, ".hermes", "SOUL.md"), "mine\n")

    const plan = runInstall(installOptions(home))
    expect(plan.writes[2]).toEqual({
      path: join(home, ".hermes", "SOUL.md"),
      skipped: "a persona already exists there and is never overwritten",
    })
  })

  test("an existing unit is refused without --force, and a dry run still shows the whole plan", () => {
    const home = tempHome()
    const unitPath = join(home, ".config", "systemd", "user", SERVICE_NAME)
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true })
    writeFileSync(unitPath, "old\n")
    const noop = () => ({ status: 0 })

    expect(() => runInstall({ ...installOptions(home), dryRun: false, run: noop })).toThrow(
      `${unitPath} already exists. Pass --force to overwrite it.`
    )
    expect({
      dryRun: runInstall(installOptions(home)).writes[0],
      forced: runInstall({ ...installOptions(home), force: true }).writes[0],
    }).toEqual({
      dryRun: { path: unitPath, skipped: "the unit already exists; pass --force to overwrite it" },
      forced: { path: unitPath },
    })
  })
})
