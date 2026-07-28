/** The tombstone a deleted message leaves behind — shared by the stream timeline
 *  and the conversation panel, so "was deleted" reads the same on both. */
export function DeletedMessageEvent() {
  return (
    <div className="py-0.5 px-3 sm:px-6 text-center">
      <p className="text-xs italic text-muted-foreground">This message was deleted</p>
    </div>
  )
}
