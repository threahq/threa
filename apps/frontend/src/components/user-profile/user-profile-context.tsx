import React, { createContext, useCallback, useContext, useState, type ReactNode } from "react"

import { BotProfileModal } from "@/components/bot-profile/bot-profile-modal"
import { UserProfileModal } from "./user-profile-modal"

interface UserProfileContextValue {
  openUserProfile: (userId: string) => void
  openBotProfile: (botId: string) => void
}

type ProfileTarget = { kind: "user"; id: string } | { kind: "bot"; id: string }

const UserProfileContext = createContext<UserProfileContextValue | null>(null)

interface UserProfileProviderProps {
  children: ReactNode
}

export function UserProfileProvider({ children }: UserProfileProviderProps) {
  const [target, setTarget] = useState<ProfileTarget | null>(null)

  const openUserProfile = useCallback((userId: string) => {
    setTarget({ kind: "user", id: userId })
  }, [])

  const openBotProfile = useCallback((botId: string) => {
    setTarget({ kind: "bot", id: botId })
  }, [])

  const close = useCallback(() => {
    setTarget(null)
  }, [])

  return (
    <UserProfileContext.Provider value={{ openUserProfile, openBotProfile }}>
      {children}
      {target?.kind === "user" && (
        <React.Suspense fallback={null}>
          <UserProfileModal userId={target.id} open onOpenChange={(open) => !open && close()} />
        </React.Suspense>
      )}
      {target?.kind === "bot" && (
        <BotProfileModal
          botId={target.id}
          open
          onOpenChange={(open) => !open && close()}
          onOpenUserProfile={openUserProfile}
        />
      )}
    </UserProfileContext.Provider>
  )
}

export function useUserProfile(): UserProfileContextValue {
  const context = useContext(UserProfileContext)
  if (!context) {
    throw new Error("useUserProfile must be used within a UserProfileProvider")
  }
  return context
}
