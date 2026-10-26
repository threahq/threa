import { createContext, useContext } from "react"

/** Whether the on-screen keyboard is up; always false off mobile. */
export const KeyboardOpenContext = createContext(false)

export function useKeyboardOpen(): boolean {
  return useContext(KeyboardOpenContext)
}
