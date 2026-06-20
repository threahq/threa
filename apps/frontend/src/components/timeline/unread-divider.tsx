interface UnreadDividerProps {
  /** Once dimmed the line settles from red to muted gray but stays in place. */
  isDimmed?: boolean
}

export function UnreadDivider({ isDimmed }: UnreadDividerProps) {
  return (
    <div
      // The line sits in the gap *above* the first-unread item, centered in the
      // extra `pt-6` (24px) that row gets while the divider shows (see
      // TimelineItemContent). `top-3` + `-translate-y-1/2` lands the line's
      // center 12px below the row top — exactly half the reserved padding — so
      // the breathing room above (to the previous row) and below (to the
      // message) is symmetric.
      //
      // Color, not opacity: the line keeps reserving its row as it settles, so
      // nothing shifts when it dims (INV-21).
      className={`absolute left-0 right-0 top-3 -translate-y-1/2 z-10 flex items-center gap-3 pointer-events-none transition-colors duration-500 ${
        isDimmed ? "text-muted-foreground" : "text-destructive"
      }`}
    >
      <div className="flex-1 border-t border-current" />
      <span className="text-xs font-medium bg-background px-2">New</span>
      <div className="flex-1 border-t border-current" />
    </div>
  )
}
