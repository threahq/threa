import { describe, expect, it } from "vitest"
import { describeExternalLink } from "./external-links"

describe("describeExternalLink", () => {
  it.each([
    ["mailto:a@example.com", null],
    ["not a url", null],
    ["/w/ws_1/s/stream_1", null],
    [
      "https://github.com/threahq/threa/pull/2977",
      { faviconHost: "github.com", provider: "github", compactLabel: "threahq/threa#2977" },
    ],
    [
      "https://www.github.com/threahq/threa/issues/12/",
      { faviconHost: "www.github.com", provider: "github", compactLabel: "threahq/threa#12" },
    ],
    [
      "https://github.com/threahq/threa/pull/2977/files",
      { faviconHost: "github.com", provider: "github", compactLabel: null },
    ],
    [
      "https://github.com/threahq/threa/pull/2977?x=1",
      { faviconHost: "github.com", provider: "github", compactLabel: null },
    ],
    [
      "https://github.com/threahq/threa/pull/2977#c",
      { faviconHost: "github.com", provider: "github", compactLabel: null },
    ],
    ["https://github.com/threahq/threa", { faviconHost: "github.com", provider: "github", compactLabel: null }],
    [
      "https://linear.app/threa/issue/thr-51/link-decoration",
      { faviconHost: "linear.app", provider: "linear", compactLabel: "THR-51" },
    ],
    [
      "https://linear.app/threa/issue/THR-51",
      { faviconHost: "linear.app", provider: "linear", compactLabel: "THR-51" },
    ],
    ["https://linear.app/threa/project/foo", { faviconHost: "linear.app", provider: "linear", compactLabel: null }],
    ["http://Example.com:8080/a", { faviconHost: "example.com:8080", provider: null, compactLabel: null }],
  ])("should describe %s when parsed", (href, expected) => {
    expect(describeExternalLink(href)).toEqual(expected)
  })
})
