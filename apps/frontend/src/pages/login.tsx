import { useAuth } from "@/auth"
import { Button } from "@/components/ui/button"
import { Navigate } from "react-router-dom"
import { ThreaLogo } from "@/components/threa-logo"

export function LoginPage() {
  const { user, login, loading } = useAuth()

  if (user) {
    return <Navigate to="/workspaces" replace />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-4">
          <ThreaLogo size="xl" />
          <div className="text-center">
            <h1 className="text-2xl font-light tracking-[0.15em] uppercase text-primary">Threa</h1>
            <p className="mt-2 text-muted-foreground text-sm">AI-powered knowledge chat</p>
          </div>
        </div>
        <Button onClick={() => login()} disabled={loading} size="lg" className="min-w-[200px]">
          {loading ? "Loading..." : "Sign in with WorkOS"}
        </Button>
      </div>
    </div>
  )
}
