/*
 * The quickstart's progress bar marks each step once the reader reaches it:
 * its heading scrolls up to where a click on its segment lands it, or the page
 * hits bottom, which reaches every step left.
 */

const WAKE_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const

function trackProgress(): void {
  const guide = document.querySelector<HTMLElement>("[data-guide]")
  if (!guide) return
  const steps = Array.from(guide.querySelectorAll<HTMLElement>(".rail-step h2"))
  const segs = Array.from(guide.querySelectorAll<HTMLElement>("[data-seg]"))
  const status = guide.querySelector<HTMLElement>("[data-guide-status]")
  const nav = document.querySelector<HTMLElement>(".docs-nav")
  if (!steps.length || !status || !nav) return

  // Fills are instant until the reader moves, so a reload or a deep link
  // restores the bar as it was instead of replaying it.
  guide.classList.add("is-still")
  const wake = () => {
    guide.classList.remove("is-still")
    for (const type of WAKE_EVENTS) removeEventListener(type, wake, true)
  }
  for (const type of WAKE_EVENTS) addEventListener(type, wake, { capture: true, passive: true })

  let reached = 1
  let frame = 0
  const track = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      document.documentElement.style.setProperty("--docs-nav-h", `${nav.offsetHeight}px`)
      const offset = nav.offsetHeight + (parseFloat(getComputedStyle(guide).getPropertyValue("--guide-bar-h")) || 0)
      // The headings' scroll-margin-top lands them at offset + 16; the slack absorbs subpixel rounding.
      const line = offset + 24
      const atBottom = scrollY >= document.documentElement.scrollHeight - innerHeight - 2
      let next = 1
      steps.forEach((h2, i) => {
        if (atBottom || h2.getBoundingClientRect().top <= line) next = Math.max(next, i + 1)
      })
      if (next === reached) return
      // Several steps reached in one frame (a jump or a fast fling) fill in turn.
      segs.forEach((seg, i) => {
        seg.style.setProperty("--fill-delay", `${Math.max(0, i - reached) * 90}ms`)
        seg.style.setProperty("--fill", i < next ? "1" : "0")
      })
      reached = next
      const title = steps[next - 1].textContent ?? ""
      status.textContent = `Step ${next} of ${steps.length}: ${title}`
    })
  }
  addEventListener("scroll", track, { passive: true })
  new ResizeObserver(track).observe(document.body)
  track()
}

trackProgress()
