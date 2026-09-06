import { useCallback, useState, type ReactNode } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { ArrowLeft, Mail } from "lucide-react"
import { MAGIC_CODE_LENGTH, type SocialProvider } from "@threahq/types"
import { API_BASE, ApiError, api } from "@/api/client"
import { useAuth } from "@/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { ThreaLogo } from "@/components/threa-logo"
import { clearLastWorkspaceId } from "@/lib/last-workspace"

type Step = "picker" | "email" | "verify"

export function AddAccountPage() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const { refetch } = useAuth()
  const [step, setStep] = useState<Step>("picker")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const redirectTo = search.get("redirect_to") || undefined

  const goSocial = useCallback(
    (provider: SocialProvider) => {
      // Same shape as the existing login flow: a full-page navigation to the
      // backend so the OAuth callback's cookie writes land before the SPA
      // boots. `intent=add` + a social provider together bypass AuthKit and
      // the IdP shows its native account picker.
      const qs = new URLSearchParams({ intent: "add", provider })
      if (redirectTo) qs.set("redirect_to", redirectTo)
      window.location.href = `${API_BASE}/api/auth/login?${qs.toString()}`
    },
    [redirectTo]
  )

  const sendCode = useCallback(async () => {
    if (!email) return
    setBusy(true)
    setError(null)
    try {
      await api.post("/api/auth/magic/send", { email })
      setStep("verify")
    } catch {
      // The endpoint deliberately replies 200 even when the email is unknown
      // (no account-existence oracle), so the only way we land here is a
      // network/server failure.
      setError("Couldn't send the code right now. Please try again.")
    } finally {
      setBusy(false)
    }
  }, [email])

  const verifyCode = useCallback(async () => {
    if (code.length !== MAGIC_CODE_LENGTH) return
    setBusy(true)
    setError(null)
    let result: { ok: boolean; redirectPath: string }
    try {
      result = await api.post<{ ok: boolean; redirectPath: string }>("/api/auth/magic/verify", {
        email,
        code,
        intent: "add",
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === "MAX_ACCOUNTS_REACHED") {
        toast.error("You're signed in to the maximum number of accounts. Remove one to add another.")
        navigate(-1)
        return
      }
      if (err instanceof ApiError && err.status === 401) {
        setError("That code didn't match. Check your email and try again.")
        setCode("")
        return
      }
      setError("Couldn't verify the code right now. Please try again.")
      return
    } finally {
      setBusy(false)
    }

    // Server-side success — the cookie is set and the magic code has been
    // consumed. From here on we must not surface an error: retrying would
    // 401, because the code is single-use. A transient refetch failure is
    // recoverable on the next route load.
    //
    // The stale last-workspace pointer would route us back into the
    // *previous* account. Same dance the OAuth callback / AuthProvider
    // mount-effect does on accountAdded=1.
    clearLastWorkspaceId()
    try {
      await refetch()
    } catch {
      // Refetch will retry on next navigation; don't block the redirect.
    }
    navigate(result.redirectPath, { replace: true })
  }, [code, email, navigate, refetch])

  return (
    <AddAccountShell>
      {/* `key={step}` re-mounts the step block on each transition so each one
          fades in instead of swapping silently. The shell itself only animates
          once on initial mount. */}
      <div key={step} className="w-full animate-in fade-in duration-300">
        {step === "picker" && (
          <PickerStep onSocial={goSocial} onEmail={() => setStep("email")} onCancel={() => navigate(-1)} />
        )}
        {step === "email" && (
          <EmailStep
            email={email}
            setEmail={setEmail}
            busy={busy}
            error={error}
            onSubmit={sendCode}
            onBack={() => {
              setStep("picker")
              setError(null)
            }}
          />
        )}
        {step === "verify" && (
          <VerifyStep
            email={email}
            code={code}
            setCode={setCode}
            busy={busy}
            error={error}
            onSubmit={verifyCode}
            onChangeEmail={() => {
              setStep("email")
              setCode("")
              setError(null)
            }}
          />
        )}
      </div>
    </AddAccountShell>
  )
}

/**
 * Centred shell shared by every step. Mirrors `JoinShell` in apps/frontend/src/pages/join.tsx
 * so the multi-account add flow visually belongs to the same auth-landing
 * family as the invitation accept and sign-in pages.
 */
function AddAccountShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,hsl(var(--primary)/0.10),transparent_55%)]"
      />
      <div className="relative flex w-full max-w-md flex-col items-center gap-10 p-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <ThreaLogo size="lg" />
        {children}
      </div>
    </div>
  )
}

function PickerStep({
  onSocial,
  onEmail,
  onCancel,
}: {
  onSocial: (provider: SocialProvider) => void
  onEmail: () => void
  onCancel: () => void
}) {
  return (
    <div className="w-full space-y-8">
      <div className="space-y-3 text-center">
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Add account</span>
        <h1 className="text-2xl font-medium leading-tight">Sign in to another account</h1>
        <p className="text-sm text-muted-foreground">
          Your current sessions stay parked — you can switch between them anytime.
        </p>
      </div>

      <div className="space-y-3">
        <ProviderButton onClick={() => onSocial("GoogleOAuth")} icon={<GoogleIcon />}>
          Continue with Google
        </ProviderButton>
        <ProviderButton onClick={() => onSocial("MicrosoftOAuth")} icon={<MicrosoftIcon />}>
          Continue with Microsoft
        </ProviderButton>

        <div className="relative py-1">
          <div aria-hidden className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border/60" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">or</span>
          </div>
        </div>

        <ProviderButton onClick={onEmail} icon={<Mail className="text-muted-foreground" />}>
          Continue with email code
        </ProviderButton>
      </div>

      <div className="text-center">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs uppercase tracking-[0.14em] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function EmailStep({
  email,
  setEmail,
  busy,
  error,
  onSubmit,
  onBack,
}: {
  email: string
  setEmail: (v: string) => void
  busy: boolean
  error: string | null
  onSubmit: () => void
  onBack: () => void
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="w-full space-y-8"
    >
      <div className="space-y-3 text-center">
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Add account</span>
        <h1 className="text-2xl font-medium leading-tight">Use email instead</h1>
        <p className="text-sm text-muted-foreground">We'll send a one-time code to verify it's you.</p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label
            htmlFor="add-account-email"
            className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground font-medium"
          >
            Email
          </Label>
          <Input
            id="add-account-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="h-11"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button
          type="submit"
          className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
          disabled={busy || !email}
        >
          {busy ? "Sending…" : "Send code"}
        </Button>
      </div>

      <div className="text-center">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <ArrowLeft className="size-3" />
          Back
        </button>
      </div>
    </form>
  )
}

function VerifyStep({
  email,
  code,
  setCode,
  busy,
  error,
  onSubmit,
  onChangeEmail,
}: {
  email: string
  code: string
  setCode: (v: string) => void
  busy: boolean
  error: string | null
  onSubmit: () => void
  onChangeEmail: () => void
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="w-full space-y-8"
    >
      <div className="space-y-6 text-center">
        <HaloMailIcon />
        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Code sent</span>
          <h1 className="text-2xl font-medium leading-tight">Check your inbox</h1>
          <p className="text-sm text-muted-foreground">
            We sent a 6-digit code to <span className="text-foreground">{email}</span>.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <InputOTP
          maxLength={MAGIC_CODE_LENGTH}
          value={code}
          onChange={setCode}
          autoFocus
          disabled={busy}
          containerClassName="justify-center"
        >
          <InputOTPGroup>
            {Array.from({ length: MAGIC_CODE_LENGTH }).map((_, i) => (
              <InputOTPSlot key={i} index={i} className="h-12 w-11 text-base font-medium" />
            ))}
          </InputOTPGroup>
        </InputOTP>

        {error && <p className="text-center text-sm text-destructive">{error}</p>}

        <Button
          type="submit"
          className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
          disabled={busy || code.length !== MAGIC_CODE_LENGTH}
        >
          {busy ? "Verifying…" : "Verify"}
        </Button>
      </div>

      <div className="text-center">
        <button
          type="button"
          onClick={onChangeEmail}
          disabled={busy}
          className="text-xs uppercase tracking-[0.14em] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
        >
          Use a different email
        </button>
      </div>
    </form>
  )
}

/** Provider button: tracked-uppercase typography would compete with brand names like "Google", so we keep these in sentence case to match the IdPs' own affordances. */
function ProviderButton({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <Button onClick={onClick} variant="outline" className="h-11 w-full justify-start gap-3 text-sm font-medium">
      {icon}
      <span>{children}</span>
    </Button>
  )
}

/** Mirrors the HaloIcon used by `JoinPage`'s SubmittedState — same visual family. */
function HaloMailIcon() {
  return (
    <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
      <div aria-hidden className="absolute inset-1 rounded-full bg-primary/15 blur-xl" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full border bg-background">
        <Mail className="h-6 w-6 text-primary" />
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.614z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  )
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#F25022" d="M0 0h8.5v8.5H0z" />
      <path fill="#7FBA00" d="M9.5 0H18v8.5H9.5z" />
      <path fill="#00A4EF" d="M0 9.5h8.5V18H0z" />
      <path fill="#FFB900" d="M9.5 9.5H18V18H9.5z" />
    </svg>
  )
}
