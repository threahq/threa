import { getBotAvatarUrl } from "@threahq/types"
import { BotIcon } from "lucide-react"

interface BotAvatarProps {
  bot: { avatarUrl?: string | null; avatarEmoji?: string | null; name: string }
  workspaceId: string
  size?: number
}

export function BotAvatar({ bot, workspaceId, size = 36 }: BotAvatarProps) {
  const avatarUrl = getBotAvatarUrl(workspaceId, bot.avatarUrl, size > 64 ? 256 : 64)

  return (
    <div
      className="rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0 overflow-hidden"
      style={{ width: size, height: size }}
    >
      {avatarUrl && <img src={avatarUrl} alt={bot.name} className="w-full h-full object-cover" />}
      {!avatarUrl && bot.avatarEmoji && <span style={{ fontSize: size * 0.5 }}>{bot.avatarEmoji}</span>}
      {!avatarUrl && !bot.avatarEmoji && (
        <BotIcon className="text-emerald-600" style={{ width: size * 0.45, height: size * 0.45 }} />
      )}
    </div>
  )
}
