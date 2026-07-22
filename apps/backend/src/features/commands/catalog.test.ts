import { describe, expect, it } from "bun:test"
import { listSessionControlCommandInfos, SESSION_CONTROL_COMMAND_NAMES } from "./catalog"

describe("session-control command catalog", () => {
  it("defines command info for every canonical runtime command", () => {
    expect(listSessionControlCommandInfos().map((command) => command.name)).toEqual([...SESSION_CONTROL_COMMAND_NAMES])
  })
})
