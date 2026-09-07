#!/usr/bin/env bun
/**
 * Rasterise every `*.html` in this directory to the `*.png` beside it.
 *
 *   bun evals/suites/image-caption/fixtures/render.ts
 *
 * The PNGs are committed so an eval run compares models, not font stacks:
 * rendering at run time would make every score depend on the machine. Chrome
 * is the renderer because Playwright's own build has no Ubuntu 26.04 download
 * and `sharp` rasterises SVG without any text at all.
 */

import { readdirSync } from "fs"
import { join } from "path"
import { chromium } from "@playwright/test"

const dir = import.meta.dir
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"))

const browser = await chromium.launch({ channel: "chrome" })
try {
  for (const file of pages) {
    const page = await browser.newPage({ viewport: { width: 900, height: 200 }, deviceScaleFactor: 2 })
    await page.goto(`file://${join(dir, file)}`)
    await page.screenshot({ path: join(dir, file.replace(/\.html$/, ".png")), fullPage: true })
    await page.close()
    console.log(`rendered ${file}`)
  }
} finally {
  await browser.close()
}
