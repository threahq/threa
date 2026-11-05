import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { t3Install } from "./config"
import { parseArgs, runInstall } from "./install"

const SERVICE_NAME = "threa-t3code-remote.service"
const WAKE_NAME = "threa-t3code-wake.service"

function setup() {
  const home = mkdtempSync(join(tmpdir(), "t3code-install-"))
  const commands: string[][] = []
  const logs: string[] = []
  return {
    home,
    commands,
    logs,
    unitPath: join(home, ".config", "systemd", "user", SERVICE_NAME),
    wakeUnitPath: join(home, ".config", "systemd", "user", WAKE_NAME),
    options: {
      install: t3Install(home),
      entryPath: "/srv/threa/extensions/t3code-remote/src/index.ts",
      runtimePath: "/home/u/.bun/bin/bun",
      log: (message: string) => logs.push(message),
      run: (command: string, args: string[]) => {
        commands.push([command, ...args])
        return { status: 0 }
      },
    },
  }
}

describe("runInstall", () => {
  test("writes the connector's unit and its waker's, then enables and starts both", () => {
    const { home, commands, unitPath, wakeUnitPath, options } = setup()
    const logDir = join(home, ".threa", "t3code-remote", "log")

    runInstall({ ...options, start: true })

    expect({
      unit: readFileSync(unitPath, "utf8"),
      wake: readFileSync(wakeUnitPath, "utf8")
        .split("\n")
        .filter((line) => /^(Description|ExecStart|Standard)/.test(line)),
      log: existsSync(join(home, ".threa", "t3code-remote", "log")),
      commands,
    }).toEqual({
      unit: [
        "[Unit]",
        "Description=Threa T3 Code connector",
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        "Environment=PATH=/home/u/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        `EnvironmentFile=-${join(home, ".config", "threa", "t3code-remote.env")}`,
        `WorkingDirectory=${join(home, ".threa", "t3code-remote", "work")}`,
        "ExecStart=/usr/bin/env THREA_T3CODE_UNIT=%n /home/u/.bun/bin/bun /srv/threa/extensions/t3code-remote/src/index.ts",
        "Restart=always",
        "RestartSec=10",
        `StandardOutput=append:${join(home, ".threa", "t3code-remote", "log", "connector.log")}`,
        `StandardError=append:${join(home, ".threa", "t3code-remote", "log", "connector.error.log")}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
      wake: [
        "Description=Threa T3 Code connector waker",
        "ExecStart=/home/u/.bun/bin/bun /srv/threa/extensions/t3code-remote/src/index.ts wake",
        `StandardOutput=append:${join(logDir, "wake.log")}`,
        `StandardError=append:${join(logDir, "wake.error.log")}`,
      ],
      log: true,
      commands: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", SERVICE_NAME, WAKE_NAME],
        ["systemctl", "--user", "restart", SERVICE_NAME, WAKE_NAME],
      ],
    })
  })

  test("an existing waker unit keeps both units unwritten without --force, and --force replaces it", () => {
    const { unitPath, wakeUnitPath, commands, options } = setup()
    mkdirSync(join(wakeUnitPath, ".."), { recursive: true })
    writeFileSync(wakeUnitPath, "theirs\n")

    expect(() => runInstall(options)).toThrow(`${wakeUnitPath} already exists. Pass --force to overwrite it.`)
    expect({ unit: existsSync(unitPath), wake: readFileSync(wakeUnitPath, "utf8"), commands }).toEqual({
      unit: false,
      wake: "theirs\n",
      commands: [],
    })

    runInstall({ ...options, force: true })
    expect(readFileSync(wakeUnitPath, "utf8")).toContain("Description=Threa T3 Code connector waker")
  })

  test("a dry run logs the plan and touches nothing", () => {
    const { home, commands, logs, options } = setup()

    runInstall({ ...options, dryRun: true })

    expect({ wrote: existsSync(join(home, ".config")) || existsSync(join(home, ".threa")), commands, logs }).toEqual({
      wrote: false,
      commands: [],
      logs: [
        `would create ${join(home, ".config", "systemd", "user")}`,
        `would create ${join(home, ".threa", "t3code-remote", "work")}`,
        `would create ${join(home, ".threa", "t3code-remote", "log")}`,
        `would write ${join(home, ".config", "systemd", "user", SERVICE_NAME)}`,
        `would write ${join(home, ".config", "systemd", "user", WAKE_NAME)}`,
        "would run systemctl --user daemon-reload",
        `would run systemctl --user enable ${SERVICE_NAME} ${WAKE_NAME}`,
      ],
    })
  })

  test("a failing systemctl stops the install", () => {
    const { options } = setup()

    expect(() => runInstall({ ...options, run: () => ({ status: 1 }) })).toThrow(
      "systemctl --user daemon-reload exited with 1"
    )
  })
})

describe("parseArgs", () => {
  test("reads the flags and rejects anything else", () => {
    expect(parseArgs(["--start", "--dry-run"])).toEqual({ force: false, start: true, dryRun: true })
    expect(() => parseArgs(["--profile", "x"])).toThrow(
      "Unknown argument --profile. Usage: threa-t3code-install [--force] [--start] [--dry-run]"
    )
  })
})
