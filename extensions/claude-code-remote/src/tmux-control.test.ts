import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { tmuxAvailable } from "./tmux-control"

describe("tmuxAvailable", () => {
  const saved = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    THREA_TMUX_TARGET: process.env.THREA_TMUX_TARGET,
  }

  beforeEach(() => {
    delete process.env.TMUX
    delete process.env.TMUX_PANE
    delete process.env.THREA_TMUX_TARGET
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("is false outside tmux", () => {
    process.env.TMUX_PANE = "%5"
    expect(tmuxAvailable()).toBe(false)
  })

  it("is false inside tmux with no pane target", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    expect(tmuxAvailable()).toBe(false)
  })

  it("is true inside tmux with a discovered pane", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.TMUX_PANE = "%5"
    expect(tmuxAvailable()).toBe(true)
  })

  it("honours an explicit THREA_TMUX_TARGET override", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1234,0"
    process.env.THREA_TMUX_TARGET = "work:claude.0"
    expect(tmuxAvailable()).toBe(true)
  })
})
