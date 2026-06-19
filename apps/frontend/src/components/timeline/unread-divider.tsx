interface UnreadDividerProps {
  /** Once dimmed the line settles from red to muted gray but stays in place. */
  isDimmed?: boolean
}

export function UnreadDivider({ isDimmed }: UnreadDividerProps) {
  return (
    <div
      // The line sits in the gap *above* the first-unread item. With
      // `-translate-y-1/2` the line's center lands exactly at the `top` value,
      // so a small positive offset places it inside that item's own top-padding
      // gap (heads `pt-3`, agent cards `py-3` — both 12px). A negative offset
      // would push the line up into the previous message's last line, since the
      // only clearance above the wrapper edge is the previous row's 2px `pb-0.5`.
      //
      // Color, not opacity: the line keeps reserving its row as it settles, so
      // nothing shifts when it dims (INV-21).
      className={`absolute left-0 right-0 top-1.5 -translate-y-1/2 z-10 flex items-center gap-3 pointer-events-none transition-colors duration-500 ${
        isDimmed ? "text-muted-foreground" : "text-destructive"
      }`}
    >
      <div className="flex-1 border-t border-current" />
      <span className="text-xs font-medium bg-background px-2">New</span>
      <div className="flex-1 border-t border-current" />
    </div>
  )
}
