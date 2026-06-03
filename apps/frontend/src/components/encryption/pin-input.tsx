import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"

/**
 * Segmented digit entry for a device PIN, shared by the setup and unlock
 * surfaces. A segmented OTP needs a FIXED length to read well and to fire
 * `onComplete` at the right moment, so the UI standardizes on a 6-digit PIN
 * (Signal/Messenger default; the crypto layer still accepts 6–8 should we add a
 * length choice later). `onComplete` fires when all six slots are filled, so the
 * unlock modal can submit without a separate button press.
 */
export const PIN_LENGTH = 6
export function PinInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
  ariaLabel = "PIN",
}: {
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  ariaLabel?: string
}) {
  return (
    <InputOTP
      maxLength={PIN_LENGTH}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      disabled={disabled}
      autoFocus={autoFocus}
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={ariaLabel}
      containerClassName="justify-center"
    >
      <InputOTPGroup>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}
