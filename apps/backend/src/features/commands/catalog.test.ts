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
      args: [{ name: "--force", required: false, description: "Reconnect despite local runtime activity" }],
    })
    expect(commands.find((command) => command.name === "clear")).toEqual({
      name: "clear",
      description: "Restart the linked session with a fresh conversation on this scratchpad",
      kind: "bot-runtime",
      scope: "stream",
      args: [{ name: "--force", required: false, description: "Clear despite local runtime activity" }],
    })
    expect(commands.find((command) => command.name === "spawn")).toEqual({
      name: "spawn",
      description: "Start a coding session in a thread under this scratchpad",
      kind: "bot-runtime",
      scope: "stream",
      args: [
        { name: "runtime", description: "Runtime to spawn; defaults to the one this scratchpad is linked to" },
        { name: "/model", description: "Model for the spawned session; omitted keeps that runtime's own default" },
        { name: "/thinking", description: "Thinking level for the spawned session" },
        { name: "name", required: true, description: "Session name; lines after the first are the prompt" },
      ],
    })
    expect(commands.find((command) => command.name === "done")).toEqual({
      name: "done",
      description:
        "Wind down this thread's session: commit, push, remove the worktree, end the link, archive the thread",
      kind: "bot-runtime",
      scope: "stream",
      args: [{ name: "--force", required: false, description: "Finish despite local runtime activity" }],
    })
  })
})
