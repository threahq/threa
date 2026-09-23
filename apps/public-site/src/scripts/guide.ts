/*
 * The quickstart's progress bar follows reading position: a step's segment
 * fills as the page scrolls through it, so every segment is full at the
 * bottom of the page.
 */

function trackProgress(): void {
  const guide = document.querySelector<HTMLElement>("[data-guide]")
  if (!guide) return
  const steps = Array.from(guide.querySelectorAll<HTMLElement>(".rail-step"))
  const segs = Array.from(guide.querySelectorAll<HTMLElement>("[data-seg]"))
  const status = guide.querySelector<HTMLElement>("[data-guide-status]")
  const nav = document.querySelector<HTMLElement>(".docs-nav")
  if (!steps.length || !status || !nav) return

  let frame = 0
  const track = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      document.documentElement.style.setProperty("--docs-nav-h", `${nav.offsetHeight}px`)
      const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight)
      const y = Math.min(scrollY, maxY)
      const offset = nav.offsetHeight + (parseFloat(getComputedStyle(guide).getPropertyValue("--guide-bar-h")) || 0)
      const starts = steps.map((li, i) =>
        i === 0 ? 0 : Math.min(maxY, li.getBoundingClientRect().top + scrollY - offset - 16)
      )
      let reading = 0
      starts.forEach((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : maxY
        const fill = end > start ? Math.min(1, Math.max(0, (y - start) / (end - start))) : y >= start ? 1 : 0
        segs[i]?.style.setProperty("--fill", String(fill))
        if (y >= start) reading = i
      })
      const title = steps[reading].querySelector("h2")?.textContent ?? ""
      status.textContent = `Step ${reading + 1} of ${steps.length}: ${title}`
    })
  }
  addEventListener("scroll", track, { passive: true })
  new ResizeObserver(track).observe(document.body)
  track()
}

trackProgress()
