import { beforeEach, describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DictationSettings } from "./dictation-settings"
import type { VoicePolishLevel } from "@threahq/types"
import * as contextsModule from "@/contexts"
import { renderWorkspaceSettings } from "@/components/workspace-settings/test-harness"

const updatePreferenceMock = vi.fn().mockResolvedValue(undefined)

let mockPreferences: {
  voiceTranscriptionModel: string | null
  voicePolishLevel: VoicePolishLevel
  voiceSteeringWords: string[]
}

function mockUsePreferences(preferences: unknown) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences,
    updatePreference: updatePreferenceMock,
    isLoading: false,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
}

function mount() {
  renderWorkspaceSettings(<DictationSettings />, { permissions: null, route: "/?settings=voice" })
}

describe("DictationSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockPreferences = {
      voiceTranscriptionModel: null,
      voicePolishLevel: "opinionated",
      voiceSteeringWords: [],
    }
    updatePreferenceMock.mockClear()
    mockUsePreferences(mockPreferences)
  })

  it("shows Automatic as the model when no voice model preference is set", () => {
    mount()

    expect(screen.getByRole("combobox")).toHaveTextContent("Automatic")
  })

  it("saves the chosen voice transcription model", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: /Deepgram Nova-3/i }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceTranscriptionModel", "deepgram:nova-3")
  })

  it("clears the voice transcription override when Automatic is picked", async () => {
    mockPreferences.voiceTranscriptionModel = "deepgram:nova-3"
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: "Automatic" }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceTranscriptionModel", null)
  })

  it("shows the currently saved voice transcription model and its description", () => {
    mockPreferences.voiceTranscriptionModel = "elevenlabs:scribe-v2-realtime"
    mount()

    const trigger = screen.getByRole("combobox")
    expect(trigger).toHaveTextContent(/ElevenLabs Scribe v2/i)
    expect(trigger).toHaveAccessibleDescription(/Higher accuracy across languages/)
  })

  it("shows Full as the selected polish level by default", () => {
    mount()
    const radio = screen.getByRole("radio", { name: /^Full$/i }) as HTMLInputElement
    expect(radio).toBeChecked()
  })

  it("saves the chosen polish level", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole("radio", { name: /^Light$/i }))
    expect(updatePreferenceMock).toHaveBeenCalledWith("voicePolishLevel", "minor")
  })

  it("turns polish off when the Off level is selected", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole("radio", { name: /^Off$/i }))
    expect(updatePreferenceMock).toHaveBeenCalledWith("voicePolishLevel", "none")
  })

  it("reflects a saved 'minor' preference as Light", () => {
    mockPreferences.voicePolishLevel = "minor"
    mount()
    const minorRadio = screen.getByRole("radio", { name: /^Light$/i }) as HTMLInputElement
    expect(minorRadio).toBeChecked()
  })

  it("defaults to Full when the preference is missing", () => {
    mockPreferences.voicePolishLevel = undefined as unknown as VoicePolishLevel
    mount()
    const radio = screen.getByRole("radio", { name: /^Full$/i }) as HTMLInputElement
    expect(radio).toBeChecked()
  })

  it("adds a typed steering word on Enter", async () => {
    const user = userEvent.setup()
    mount()

    await user.type(screen.getByLabelText("Add a dictation steering word"), "Langfuse{Enter}")

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceSteeringWords", ["Langfuse"])
  })

  it("ignores a re-add of a baked-in term and explains why instead of silently clearing", async () => {
    const user = userEvent.setup()
    mount()

    await user.type(screen.getByLabelText("Add a dictation steering word"), "threa{Enter}")

    expect({
      saved: updatePreferenceMock.mock.calls,
      announced: screen.getByText(/already included/i).textContent,
      placeholder: screen.getByLabelText("Add a dictation steering word").getAttribute("placeholder"),
    }).toEqual({ saved: [], announced: '"threa" is already included.', placeholder: "Already included" })
  })

  it("disables the steering-word input until preferences have loaded (no clobber from an empty baseline)", () => {
    mockUsePreferences(null)
    mount()

    expect(screen.getByLabelText("Add a dictation steering word")).toBeDisabled()
  })

  it("removes a saved steering word", async () => {
    mockPreferences.voiceSteeringWords = ["Langfuse", "pgvector"]
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole("button", { name: "Remove Langfuse" }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceSteeringWords", ["pgvector"])
  })
})
