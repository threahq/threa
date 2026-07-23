import { describe, expect, it } from "bun:test"
import { listSessionControlCommandInfos, SESSION_CONTROL_COMMAND_NAMES } from "./catalog"

describe("session-control command catalog", () => {
  it("defines command info for every canonical runtime command", () => {
    const commands = listSessionControlCommandInfos()
    expect(commands.map((command) => command.name)).toEqual([...SESSION_CONTROL_COMMAND_NAMES])
    expect(commands.find((command) => command.name === "reconnect")).toEqual({
      name: "reconnect",
      description: "Reconnect the linked live session",
      kind: "bot-runtime",
      scope: "stream",
      args: [{ name: "--force", required: false, description: "Reconnect even when the runtime is busy" }],
    })
  })
})
