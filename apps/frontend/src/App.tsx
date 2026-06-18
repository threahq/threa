import { RouterProvider } from "react-router-dom"
import { AuthProvider, AccountScopeProvider } from "./auth"
import {
  AccountQueryClientProvider,
  ServicesProvider,
  PendingMessagesProvider,
  DictationCoordinatorProvider,
} from "./contexts"
import { router } from "./routes"
import { TooltipProvider } from "./components/ui/tooltip"
import { useInlineEditPresenceAttribute } from "./hooks/use-inline-edit-presence-attribute"

export function App() {
  useInlineEditPresenceAttribute()

  return (
    <AuthProvider>
      <AccountScopeProvider>
        <AccountQueryClientProvider>
          <ServicesProvider>
            <PendingMessagesProvider>
              <DictationCoordinatorProvider>
                <TooltipProvider delayDuration={300}>
                  <RouterProvider router={router} />
                </TooltipProvider>
              </DictationCoordinatorProvider>
            </PendingMessagesProvider>
          </ServicesProvider>
        </AccountQueryClientProvider>
      </AccountScopeProvider>
    </AuthProvider>
  )
}
