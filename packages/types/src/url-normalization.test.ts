import { describe, expect, test } from "bun:test"
import { LINK_FAVICON_HOST_MAX_LENGTH, linkFaviconHost } from "./url-normalization"

describe("linkFaviconHost", () => {
  test("should key a web link on its host and give no key to a link no site can have", () => {
    const longestHost = `${"a".repeat(LINK_FAVICON_HOST_MAX_LENGTH - 8)}.example`

    expect({
      https: linkFaviconHost("https://Example.com/a?b=1"),
      port: linkFaviconHost("http://dev.example:8080/"),
      defaultPort: linkFaviconHost("https://example.com:443/"),
      idn: linkFaviconHost("https://bücher.example/"),
      longest: linkFaviconHost(`https://${longestHost}/`),
      tooLong: linkFaviconHost(`https://a${longestHost}/`),
      dot: linkFaviconHost("https://./"),
      dots: linkFaviconHost("https://%2e%2e/"),
      mailto: linkFaviconHost("mailto:someone@example.com"),
      relative: linkFaviconHost("/relative/path"),
    }).toEqual({
      https: "example.com",
      port: "dev.example:8080",
      defaultPort: "example.com",
      idn: "xn--bcher-kva.example",
      longest: longestHost,
      tooLong: null,
      dot: null,
      dots: null,
      mailto: null,
      relative: null,
    })
  })
})
