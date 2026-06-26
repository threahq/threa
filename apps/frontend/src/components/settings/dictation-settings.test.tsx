import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DictationSettings } from "./dictation-settings"
import type { VoicePolishLevel } from "@threa/types"
import * as contextsModule from "@/contexts"

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

  it("selects 'Use server default' when no voice model preference is set", () => {
    render(<DictationSettings />)

    const defaultRadio = screen.getByRole("radio", { name: /Use server default/i }) as HTMLInputElement
    expect(defaultRadio).toBeChecked()
  })

  it("saves the chosen voice transcription model", async () => {
    const user = userEvent.setup()
    render(<DictationSettings />)

    await user.click(screen.getByRole("radio", { name: /Deepgram Nova-3/i }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceTranscriptionModel", "deepgram:nova-3")
  })

  it("clears the voice transcription override when 'Use server default' is picked", async () => {
    mockPreferences.voiceTranscriptionModel = "deepgram:nova-3"
    const user = userEvent.setup()
    render(<DictationSettings />)

    await user.click(screen.getByRole("radio", { name: /Use server default/i }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceTranscriptionModel", null)
  })

  it("shows the currently saved voice transcription model as selected", () => {
    mockPreferences.voiceTranscriptionModel = "elevenlabs:scribe-v2-realtime"
    render(<DictationSettings />)

    const elevenLabsRadio = screen.getByRole("radio", { name: /ElevenLabs Scribe v2/i }) as HTMLInputElement
    expect(elevenLabsRadio).toBeChecked()
  })

  it("shows Opinionated as the selected polish level by default", () => {
    render(<DictationSettings />)
    const radio = screen.getByRole("radio", { name: /Opinionated/i }) as HTMLInputElement
    expect(radio).toBeChecked()
  })

  it("saves the chosen polish level", async () => {
    const user = userEvent.setup()
    render(<DictationSettings />)

    await user.click(screen.getByRole("radio", { name: /^Minor$/i }))
    expect(updatePreferenceMock).toHaveBeenCalledWith("voicePolishLevel", "minor")
  })

  it("turns polish off when the Off level is selected", async () => {
    const user = userEvent.setup()
    render(<DictationSettings />)

    await user.click(screen.getByRole("radio", { name: /^Off$/i }))
    expect(updatePreferenceMock).toHaveBeenCalledWith("voicePolishLevel", "none")
  })

  it("reflects a saved 'minor' preference", () => {
    mockPreferences.voicePolishLevel = "minor"
    render(<DictationSettings />)
    const minorRadio = screen.getByRole("radio", { name: /^Minor$/i }) as HTMLInputElement
    expect(minorRadio).toBeChecked()
  })

  it("defaults to Opinionated when the preference is missing", () => {
    mockPreferences.voicePolishLevel = undefined as unknown as VoicePolishLevel
    render(<DictationSettings />)
    const radio = screen.getByRole("radio", { name: /Opinionated/i }) as HTMLInputElement
    expect(radio).toBeChecked()
  })

  it("shows the baked-in product terms as always-on, non-removable chips", () => {
    render(<DictationSettings />)
    expect(screen.getByText("Threa")).toBeInTheDocument()
    expect(screen.getByText("Ariadne")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Remove Threa/i })).not.toBeInTheDocument()
  })

  it("adds a typed steering word on Enter", async () => {
    const user = userEvent.setup()
    render(<DictationSettings />)

    await user.type(screen.getByLabelText("Add a dictation steering word"), "Langfuse{Enter}")

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceSteeringWords", ["Langfuse"])
  })

  it("ignores a re-add of a baked-in term and explains why instead of silently clearing", async () => {
    const user = userEvent.setup()
    render(<DictationSettings />)

    await user.type(screen.getByLabelText("Add a dictation steering word"), "threa{Enter}")

    expect(updatePreferenceMock).not.toHaveBeenCalled()
    expect(screen.getByText(/already included/i)).toBeInTheDocument()
  })

  it("disables the steering-word input until preferences have loaded (no clobber from an empty baseline)", () => {
    mockUsePreferences(null)
    render(<DictationSettings />)

    expect(screen.getByLabelText("Add a dictation steering word")).toBeDisabled()
  })

  it("removes a saved steering word", async () => {
    mockPreferences.voiceSteeringWords = ["Langfuse", "pgvector"]
    const user = userEvent.setup()
    render(<DictationSettings />)

    await user.click(screen.getByRole("button", { name: "Remove Langfuse" }))

    expect(updatePreferenceMock).toHaveBeenCalledWith("voiceSteeringWords", ["pgvector"])
  })
})
