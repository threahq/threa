import { createContext, useContext, type ReactNode } from "react"
import { getCallManager, type CallController } from "@/calls/call-manager"

// Components speak to the call only through this handle (INV-15 — never the
// transport or sockets). Production resolves the account-scoped singleton;
// tests inject a spy fake via the provider.
const CallManagerContext = createContext<CallController | null>(null)

export function CallManagerProvider({ manager, children }: { manager: CallController; children: ReactNode }) {
  return <CallManagerContext.Provider value={manager}>{children}</CallManagerContext.Provider>
}

export function useCallManager(): CallController {
  return useContext(CallManagerContext) ?? getCallManager()
}
