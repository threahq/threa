import { describe, expect, it } from "vitest"
import type { LinkPreviewSummary } from "@threahq/types"
import { classifyLinkPreview, resolveLinkPreviewDefaults } from "./link-preview-policy"
const web: LinkPreviewSummary = {
  id: "p",
  url: "https://example.com",
  title: null,
  description: null,
  imageUrl: "https://example.com/thumb.png",
  faviconUrl: null,
  siteName: null,
  contentType: "website",
  position: 0,
}
const previews = [web, { ...web, id: "image", contentType: "image" as const }, { ...web, id: "web2" }]
describe("link preview policy", () => {
  it("should keep website thumbnails classified as websites", () => expect(classifyLinkPreview(web)).toBe("website"))
  it("should classify provider hosts and explicit content types", () => {
    expect(
      [
        { ...web, url: "https://github.com/example/repo" },
        { ...web, url: "https://linear.app/example/issue/EX-1" },
        { ...web, previewType: "video" as const },
        { ...web, contentType: "pdf" as const },
        { ...web, url: "https://github.com.example.com/repo" },
        { ...web, previewType: "github_pr" as const },
        { ...web, previewType: "linear_issue" as const },
      ].map(classifyLinkPreview)
    ).toEqual(["github", "linear", "video", "pdf", "website", "github", "linear"])
  })
  it("should preserve legacy open-first-three and collapsed modes", () => {
    const four = [...previews, { ...web, id: "web3" }]
    expect(resolveLinkPreviewDefaults(four, null, false).map(({ defaultOpen }) => defaultOpen)).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(
      resolveLinkPreviewDefaults(four, { linkPreviewDefault: "collapsed" }, false).map(({ defaultOpen }) => defaultOpen)
    ).toEqual([false, false, false, false])
  })
  it("should exclude zero overrides from the inherited counter", () => {
    expect(
      resolveLinkPreviewDefaults(
        [previews[1]!, web, previews[2]!],
        { linkPreviewOpenCount: 1, linkPreviewTypeOverrides: { image: 0 } },
        false
      ).map(({ defaultOpen }) => defaultOpen)
    ).toEqual([false, true, false])
  })
  it("should share inherited counts and count explicit types separately", () => {
    expect(
      resolveLinkPreviewDefaults(
        previews,
        { linkPreviewOpenCount: 1, linkPreviewTypeOverrides: { image: "all" } },
        false
      ).map(({ defaultOpen }) => defaultOpen)
    ).toEqual([true, true, false])
    expect(
      resolveLinkPreviewDefaults(
        previews,
        { linkPreviewOpenCount: 1, linkPreviewTypeOverrides: { image: 1 } },
        false
      ).map(({ defaultOpen }) => defaultOpen)
    ).toEqual([true, true, false])
  })
  it("should preserve collapsed defaults while permitting type overrides", () => {
    expect(
      resolveLinkPreviewDefaults(
        previews,
        { linkPreviewDefault: "collapsed", linkPreviewTypeOverrides: { image: "all" } },
        false
      ).map(({ defaultOpen }) => defaultOpen)
    ).toEqual([false, true, false])
  })
  it("should cap internal previews independently", () => {
    const internal = Array.from({ length: 4 }, (_, i) => ({
      ...web,
      id: `internal${i}`,
      contentType: "memo_link" as const,
    }))
    expect(
      resolveLinkPreviewDefaults([...internal, web], { linkPreviewOpenCount: 1 }, false).map(
        ({ preview }) => preview.id
      )
    ).toEqual(["internal0", "internal1", "internal2", "p"])
  })
  it("should accept all and arbitrary large counts", () => {
    for (const linkPreviewOpenCount of ["all" as const, 100])
      expect(
        resolveLinkPreviewDefaults(previews, { linkPreviewOpenCount }, false).map(({ defaultOpen }) => defaultOpen)
      ).toEqual([true, true, true])
  })
})
