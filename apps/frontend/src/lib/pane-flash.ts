/** Pulses the pane on show when a link or pick lands where the reader already is, so the tap shows it registered. */
export function flashPane(paneId: string): void {
  const pane = document.querySelector<HTMLElement>(`[data-panel-tab="${CSS.escape(paneId)}"]`)
  if (!pane) return
  pane.classList.remove("pane-flash")
  // Restarts the animation on a second tap while the first still runs.
  void pane.offsetWidth
  pane.classList.add("pane-flash")
  pane.addEventListener("animationend", () => pane.classList.remove("pane-flash"), { once: true })
}
