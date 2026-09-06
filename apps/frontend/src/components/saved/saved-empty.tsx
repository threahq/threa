import { Bookmark } from "lucide-react"
import type { SavedStatus } from "@threahq/types"

const MESSAGES: Record<SavedStatus, { title: string; body: string }> = {
  saved: {
    title: "No saved messages",
    body: "Save any message to come back to it later. Use the bookmark button on hover or the message context menu.",
  },
  done: {
    title: "No done items yet",
    body: "Items you mark as done appear here, ordered by when you completed them.",
  },
  archived: {
    title: "Nothing archived",
    body: "Items you archive appear here — things you decided not to act on.",
  },
}

export function SavedEmpty({ status }: { status: SavedStatus }) {
  const msg = MESSAGES[status]
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
        <Bookmark className="w-6 h-6 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold mb-1">{msg.title}</h2>
      <p className="text-sm text-muted-foreground max-w-md">{msg.body}</p>
    </div>
  )
}
