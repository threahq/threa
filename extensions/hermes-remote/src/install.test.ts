import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderSystemdUnit, runInstall, SERVICE_NAME } from "./install"

const PACKAGE_DIR = join(import.meta.dir, "..")

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hermes-install-"))
}

function installOptions(homeDir: string) {
  return { homeDir, packageDir: PACKAGE_DIR, bunPath: "/home/u/.bun/bin/bun", dryRun: true }
}

describe("renderSystemdUnit", () => {
  test("renders the connector unit with absolute paths and appended logs", () => {
    expect(
      renderSystemdUnit({
        bunPath: "/home/u/.bun/bin/bun",
        entryPath: "/srv/threa/extensions/hermes-remote/src/index.ts",
        homeDir: "/home/u",
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
})

describe("renderSystemdUnit paths", () => {
  test("a path systemd would split or unescape is refused", () => {
    expect(() =>
      renderSystemdUnit({
        bunPath: "/home/u/.bun/bin/bun",
        entryPath: "/home/my user/threa/extensions/hermes-remote/src/index.ts",
        homeDir: "/home/my user",
        envFile: "/home/my user/.config/threa/hermes-remote.env",
      })
    ).toThrow("whitespace and backslashes")
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
