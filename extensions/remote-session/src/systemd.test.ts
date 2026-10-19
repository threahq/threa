import { describe, expect, test } from "bun:test"
import { connectorEntry, renderUserUnit } from "./systemd"

const UNIT = {
  description: "Threa Demo connector",
  runtimePath: "/usr/bin/node",
  entryPath: "/opt/demo/index.js",
  workingDirectory: "/home/u/.threa/demo/work",
  logDir: "/home/u/.threa/demo/log",
  envFile: "/home/u/.config/threa/demo.env",
}

describe("renderUserUnit", () => {
  test("a unit with no dependencies waits for the network only", () => {
    expect(renderUserUnit(UNIT).split("\n").slice(0, 3)).toEqual([
      "[Unit]",
      "Description=Threa Demo connector",
      "After=network-online.target",
    ])
  })

  test("a pinned value systemd would split is refused like a path", () => {
    expect(() => renderUserUnit({ ...UNIT, pinnedEnvironment: { NAME: "two words" } })).toThrow(
      "whitespace and backslashes"
    )
  })
})

describe("connectorEntry", () => {
  test("a checkout's installer runs the source entry from the package root", () => {
    expect(connectorEntry("file:///srv/threa/extensions/demo/src/install.ts", "@threahq/demo")).toEqual({
      entryPath: "/srv/threa/extensions/demo/src/index.ts",
      packageDir: "/srv/threa/extensions/demo",
    })
  })

  test("an npm build runs the bundled entry beside it", () => {
    expect(connectorEntry("file:///usr/lib/node_modules/@threahq/demo/install.js", "@threahq/demo")).toEqual({
      entryPath: "/usr/lib/node_modules/@threahq/demo/index.js",
      packageDir: "/usr/lib/node_modules/@threahq/demo",
    })
  })

  test("npx's cache is refused, since npm clears it under the unit", () => {
    expect(() =>
      connectorEntry("file:///home/u/.npm/_npx/abc/node_modules/@threahq/demo/install.js", "@threahq/demo")
    ).toThrow("npm install -g @threahq/demo")
  })
})
