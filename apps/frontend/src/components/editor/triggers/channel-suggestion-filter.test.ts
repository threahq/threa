import { describe, it, expect } from "vitest"
import { filterChannels, parseChannelQuery } from "./use-channel-suggestion"
import type { ChannelItem } from "./types"

const ITEMS: ChannelItem[] = [
  { id: "stream_pizza", slug: "pizza", name: "#pizza", type: "channel" },
  { id: "stream_general", slug: "general", name: "#general", type: "channel" },
  { id: "stream_pi", slug: "pi-remote-control", name: "Pi remote control", type: "scratchpad" },
  { id: "stream_plan", slug: "pipeline-notes", name: "Pipeline notes", type: "scratchpad" },
]

describe("parseChannelQuery", () => {
  it("treats a bare query as an unscoped search", () => {
    expect(parseChannelQuery("pi")).toEqual({ channelsOnly: false, term: "pi" })
  })

  it("reads a leading second sigil as the channels-only scope", () => {
    expect(parseChannelQuery("#pi")).toEqual({ channelsOnly: true, term: "pi" })
  })

  it("scopes on the sigil alone, before any term is typed", () => {
    expect(parseChannelQuery("#")).toEqual({ channelsOnly: true, term: "" })
  })
})

describe("filterChannels", () => {
  it("ranks channels and scratchpads together on one ladder for a bare query", () => {
    // `pi` is a whole word of the scratchpad's slug and only a prefix of
    // `pizza`/`pipeline-notes`, so relevance puts the pad first — the
    // channels-first input order is a tiebreak, not a thumb on the scale.
    expect(filterChannels(ITEMS, "pi").map((item) => item.id)).toEqual(["stream_pi", "stream_pizza", "stream_plan"])
  })

  it("drops scratchpads once the second sigil narrows the scope", () => {
    expect(filterChannels(ITEMS, "#pi").map((item) => item.id)).toEqual(["stream_pizza"])
  })

  it("offers nothing for the bare `##`, so an h2 marker still sends on Enter", () => {
    expect(filterChannels(ITEMS, "#")).toEqual([])
  })

  it("matches a scratchpad on its display name, not just the folded slug", () => {
    expect(filterChannels(ITEMS, "remote").map((item) => item.id)).toEqual(["stream_pi"])
  })
})
