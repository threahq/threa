import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as Y from "yjs"
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness"
import { bytesToBase64 } from "@threahq/crypto"
import * as hooksModule from "@/hooks"
import * as userProfileModule from "@/components/user-profile"
import { DocPresence, type PresenceUser } from "@/lib/docs/doc-presence"
import { DocPresenceAvatars } from "./doc-presence-avatars"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"

function user(userId: string, name: string): PresenceUser {
  return { userId, name, color: "#2563eb" }
}

describe("DocPresenceAvatars", () => {
  const disposables: Array<{ destroy: () => void }> = []
  let presence: DocPresence
  let openUserProfile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const ydoc = new Y.Doc()
    presence = new DocPresence({ ydoc, workspaceId: WORKSPACE_ID, docId: DOC_ID, send: () => {} })
    disposables.push(ydoc, presence)
    presence.setLocalUser(user("usr_viewer", "Viewer"))
    openUserProfile = vi.fn()
    vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile, openBotProfile: vi.fn() })
    vi.spyOn(hooksModule, "useActors").mockReturnValue({
      getActorAvatar: () => ({ fallback: "AB" }),
    } as unknown as ReturnType<typeof hooksModule.useActors>)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    for (const disposable of disposables.splice(0).reverse()) disposable.destroy()
  })

  function join(peer: PresenceUser) {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    disposables.push(ydoc, awareness)
    awareness.setLocalStateField("user", peer)
    act(() =>
      presence.receive({
        workspaceId: WORKSPACE_ID,
        docId: DOC_ID,
        update: bytesToBase64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
      })
    )
  }

  function mount() {
    return render(<DocPresenceAvatars workspaceId={WORKSPACE_ID} presence={presence} />)
  }

  function names() {
    return screen.queryAllByRole("button").map((button) => button.getAttribute("aria-label"))
  }

  it("should render nothing when nobody else is in the doc", () => {
    const { container } = mount()
    expect(container).toBeEmptyDOMElement()
  })

  it("should show a named button per peer that opens their profile when clicked", async () => {
    mount()
    join(user("usr_ada", "Ada"))
    join(user("usr_bo", "Bo"))

    await userEvent.click(screen.getByRole("button", { name: "Bo" }))

    expect({ names: names(), opened: openUserProfile.mock.calls }).toEqual({
      names: ["Ada", "Bo"],
      opened: [["usr_bo"]],
    })
  })

  it("should show one avatar when the same person is in the doc from two tabs", () => {
    mount()
    join(user("usr_ada", "Ada"))
    join(user("usr_ada", "Ada"))
    expect(names()).toEqual(["Ada"])
  })

  it("should show three avatars and the overflow count when five people are in the doc", () => {
    mount()
    for (const name of ["Ada", "Bo", "Cy", "Di", "Ed"]) join(user(`usr_${name.toLowerCase()}`, name))
    expect({ names: names(), overflow: screen.getByText("+2").tagName }).toEqual({
      names: ["Ada", "Bo", "Cy"],
      overflow: "SPAN",
    })
  })
})
