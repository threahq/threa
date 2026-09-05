import { StreamTypes } from "@threa/types"
import { InAppLinkChip } from "@/components/in-app-link/in-app-link-chip"
import { streamChipParts } from "@/lib/streams"
import { useChannelChipById } from "./channel-link-context"

/**
 * The chip for a resolved `#` stream link, drawn from the authoritative
 * `attrs.id` (INV-64) so a rename lands everywhere the link already sits and a
 * scratchpad reads under its real name instead of a folded slug. Shared by the
 * composer node view and the timeline renderer so the draft and the posted
 * message never disagree. `slug` is the display-only fallback for a target the
 * viewer has no cached row for — including every render outside a
 * `ChannelLinkProvider` — and INV-64 writes it in the channel form, so it keeps
 * rendering that way.
 */
export function StreamChip({ id, slug }: { id: string; slug: string }) {
  const target = useChannelChipById()(id)
  const parts = streamChipParts(target?.type ?? StreamTypes.CHANNEL, target?.label ?? slug)
  return <InAppLinkChip icon={parts.icon} prefix={parts.prefix} label={parts.label} />
}
