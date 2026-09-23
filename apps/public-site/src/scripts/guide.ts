/*
 * The quickstart's progress bar marks each step once the reader reaches it:
 * its heading crosses a line a third of the way down the view, or the page
 * hits bottom, which reaches every step left.
 */

function trackProgress(): void {
  const guide = document.querySelector<HTMLElement>("[data-guide]")
  if (!guide) return
  const steps = Array.from(guide.querySelectorAll<HTMLElement>(".rail-step"))
  const segs = Array.from(guide.querySelectorAll<HTMLElement>("[data-seg]"))
  const status = guide.querySelector<HTMLElement>("[data-guide-status]")
  const nav = document.querySelector<HTMLElement>(".docs-nav")
  if (!steps.length || !status || !nav) return

  let reached = 1
  let frame = 0
  const track = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      document.documentElement.style.setProperty("--docs-nav-h", `${nav.offsetHeight}px`)
      const offset = nav.offsetHeight + (parseFloat(getComputedStyle(guide).getPropertyValue("--guide-bar-h")) || 0)
      const line = offset + (innerHeight - offset) / 3
      const atBottom = scrollY >= document.documentElement.scrollHeight - innerHeight - 2
      let next = 1
      steps.forEach((li, i) => {
        if (atBottom || li.getBoundingClientRect().top <= line) next = Math.max(next, i + 1)
      })
      if (next === reached) return
      // Several steps reached in one frame (a jump or a fast fling) fill in turn.
      segs.forEach((seg, i) => {
        seg.style.setProperty("--fill-delay", `${Math.max(0, i - reached) * 90}ms`)
        seg.style.setProperty("--fill", i < next ? "1" : "0")
      })
      reached = next
      const title = steps[next - 1].querySelector("h2")?.textContent ?? ""
      status.textContent = `Step ${next} of ${steps.length}: ${title}`
    })
  }
  addEventListener("scroll", track, { passive: true })
  new ResizeObserver(track).observe(document.body)
  track()
}

trackProgress()
