import { useState, useMemo, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { SearchableList } from "@/components/ui/searchable-list"
import { renderUserListItem, type UserListItem } from "@/components/ui/user-list-item"
import { UserPlus, X } from "lucide-react"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { getInitials } from "@/lib/initials"
import { getAvatarColor } from "@/lib/avatar-color"
import { rankMatches } from "@/lib/match-score"

interface UserPickerProps {
  workspaceId: string
  currentUserId: string
  selectedUserIds: string[]
  onChange: (userIds: string[]) => void
}

export function UserPicker({ workspaceId, currentUserId, selectedUserIds, onChange }: UserPickerProps) {
  const [search, setSearch] = useState("")
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const selectedSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds])

  const availableToAdd = useMemo((): UserListItem[] => {
    // Trimmed: rankMatches treats a whitespace-only query as "not searching
    // yet" and returns every candidate, which here would dump the whole
    // member list the moment a stray space is typed.
    if (!search.trim()) return []
    const candidates = workspaceUsers.filter((m) => m.id !== currentUserId && !selectedSet.has(m.id))
    return rankMatches(candidates, search, (m) => ({ labels: [m.name, m.slug] })).map((m) => ({
      id: m.id,
      label: m.name || m.slug,
      description: `@${m.slug}`,
      slug: m.slug,
      name: m.name,
    }))
  }, [workspaceUsers, currentUserId, selectedSet, search])

  const selectedUsers = useMemo(() => {
    return selectedUserIds.map((id) => workspaceUsers.find((u) => u.id === id)).filter(Boolean) as typeof workspaceUsers
  }, [selectedUserIds, workspaceUsers])

  const handleSelect = useCallback(
    (item: UserListItem) => {
      onChange([...selectedUserIds, item.id])
      setSearch("")
    },
    [selectedUserIds, onChange]
  )

  const handleRemove = (userId: string) => {
    onChange(selectedUserIds.filter((id) => id !== userId))
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Users</Label>
      <p className="text-xs text-muted-foreground -mt-1.5">You'll be added automatically as the creator</p>

      {selectedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedUsers.map((user) => {
            const initials = getInitials(user.name || user.slug)
            const color = getAvatarColor(user.id)

            return (
              <Badge key={user.id} variant="secondary" className="gap-1.5 pl-1 pr-1.5 py-0.5 text-xs font-medium">
                <span
                  className={`inline-flex items-center justify-center h-4.5 w-4.5 rounded-full text-[9px] font-semibold leading-none shrink-0 ${color}`}
                  style={{ width: 18, height: 18 }}
                >
                  {initials}
                </span>
                {user.name || user.slug}
                <button
                  type="button"
                  onClick={() => handleRemove(user.id)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5 -mr-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )
          })}
        </div>
      )}

      <SearchableList
        items={availableToAdd}
        renderItem={renderUserListItem}
        onSelect={handleSelect}
        search={search}
        onSearchChange={setSearch}
        placeholder="Search by name or handle..."
        emptyMessage="No matching users"
        icon={UserPlus}
      />
    </div>
  )
}
