/** Renders a page in a real browser, for pages a plain request cannot read. */
export interface PageBrowser {
  /** Returns the rendered page as markdown. */
  read(url: string, signal: AbortSignal): Promise<string>
}

const INLINE_IMAGE = /!\[[^\]]*\]\(data:[^)]*\)/g

export function createBrowserbasePageBrowser(apiKey: string): PageBrowser {
  return {
    read: async (url, signal) => {
      const response = await fetch("https://api.browserbase.com/v1/fetch", {
        method: "POST",
        signal,
        headers: { "X-BB-API-Key": apiKey, "Content-Type": "application/json" },
        // Without its proxies Reddit and Instagram refuse the browser as they refuse us.
        body: JSON.stringify({ url, format: "markdown", proxies: true }),
      })
      if (!response.ok) {
        throw new Error(`Browserbase ${response.status}: ${(await response.text()).slice(0, 300)}`)
      }
      const data = (await response.json()) as { statusCode?: number; content?: string }
      if ((data.statusCode ?? 200) >= 400) throw new Error(`the page answered ${data.statusCode} in a browser too`)
      const content = data.content?.replace(INLINE_IMAGE, "").trim()
      if (!content) throw new Error("the page had no text in a browser either")
      return content
    },
  }
}
