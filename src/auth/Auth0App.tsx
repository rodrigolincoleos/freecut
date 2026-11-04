import { Fragment, useState, type ReactNode } from 'react'
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import { Capacitor } from '@capacitor/core'

type Auth0AppProps = {
  children: ReactNode
}

type Auth0Config = {
  domain: string
  clientId: string
  audience: string
}

function getAuth0Config(): Auth0Config | null {
  const { VITE_AUTH0_DOMAIN: domain, VITE_AUTH0_CLIENT_ID: clientId, VITE_AUTH0_AUDIENCE: audience } = import.meta.env
  if (!domain?.trim() || !clientId?.trim() || !audience?.trim()) return null
  return { domain: domain.trim(), clientId: clientId.trim(), audience: audience.trim() }
}

function AuthLoading() {
  return (
    <main className="auth-page" aria-live="polite">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark">f</span><span>freecut</span></div>
        <span className="spinner auth-spinner" />
        <p>Comprobando tu sesión…</p>
      </section>
    </main>
  )
}

function AuthWelcome() {
  const { loginWithRedirect, error } = useAuth0()
  const [isRedirecting, setIsRedirecting] = useState(false)
  const [loginError, setLoginError] = useState('')
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`

  const login = async () => {
    setIsRedirecting(true)
    setLoginError('')
    try {
      await loginWithRedirect({ appState: { returnTo } })
    } catch (loginError) {
      setIsRedirecting(false)
      setLoginError(loginError instanceof Error ? loginError.message : 'No se pudo iniciar el acceso.')
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark">f</span><span>freecut</span></div>
        <span className="eyebrow">EDITOR DE VIDEO</span>
        <h1>Tu espacio creativo te espera</h1>
        <p>Inicia sesión o crea una cuenta para abrir FreeCut.</p>
        {(error || loginError) && (
          <p className="auth-error" role="alert">
            No se pudo completar la autenticación: {loginError || error?.message}
          </p>
        )}
        <button className="auth-submit" type="button" onClick={() => void login()} disabled={isRedirecting}>
          {isRedirecting ? <><span className="spinner" /> Conectando…</> : 'Iniciar sesión o registrarse'}
        </button>
        <small>La autenticación segura se realiza en Auth0.</small>
      </section>
    </main>
  )
}

function EmailVerificationRequired() {
  const { loginWithRedirect } = useAuth0()
  const [isRedirecting, setIsRedirecting] = useState(false)
  const [redirectError, setRedirectError] = useState('')

  const verifyAgain = async () => {
    setIsRedirecting(true)
    setRedirectError('')
    try {
      await loginWithRedirect({
        authorizationParams: { prompt: 'login' },
        appState: { returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}` },
      })
    } catch (error) {
      setIsRedirecting(false)
      setRedirectError(error instanceof Error ? error.message : 'No se pudo volver a iniciar sesión.')
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark">f</span><span>freecut</span></div>
        <span className="eyebrow">VERIFICA TU CORREO</span>
        <h1>Confirma tu dirección de correo</h1>
        <p>Para proteger tu cuenta, verifica el correo electrónico desde el mensaje de Auth0 y vuelve a iniciar sesión.</p>
        {redirectError && <p className="auth-error" role="alert">{redirectError}</p>}
        <button className="auth-submit" type="button" onClick={() => void verifyAgain()} disabled={isRedirecting}>
          {isRedirecting ? 'Comprobando…' : 'Ya verifiqué mi correo'}
        </button>
      </section>
    </main>
  )
}

function AuthenticatedContent({ children }: Auth0AppProps) {
  const { isLoading, isAuthenticated, user } = useAuth0()
  if (isLoading) return <AuthLoading />
  if (!isAuthenticated) return <AuthWelcome />
  if (!user?.sub) {
    return (
      <main className="auth-page">
        <section className="auth-card" role="alert">
          <div className="auth-brand"><span className="brand-mark">f</span><span>freecut</span></div>
          <h1>No se pudo identificar tu cuenta</h1>
          <p>Vuelve a iniciar sesión. No se cargarán proyectos sin una identidad Auth0 válida.</p>
        </section>
      </main>
    )
  }
  if (user?.email_verified !== true) return <EmailVerificationRequired />
  return <Fragment key={user.sub}>{children}</Fragment>
}

function Auth0ProviderWithConfig({ children }: Auth0AppProps) {
  if (Capacitor.isNativePlatform()) {
    return (
      <main className="auth-page">
        <section className="auth-card" role="alert">
          <div className="auth-brand"><span className="brand-mark">f</span><span>freecut</span></div>
          <h1>Acceso móvil en preparación</h1>
          <p>El inicio de sesión móvil requiere una aplicación nativa de Auth0 y enlaces de retorno seguros. Esta versión no abrirá el editor sin autenticación.</p>
        </section>
      </main>
    )
  }

  const config = getAuth0Config()
  if (!config) {
    return (
      <main className="auth-page">
        <section className="auth-card" role="alert">
          <div className="auth-brand"><span className="brand-mark">f</span><span>freecut</span></div>
          <h1>Falta configurar el acceso</h1>
          <p>Configura VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID y VITE_AUTH0_AUDIENCE para iniciar FreeCut.</p>
        </section>
      </main>
    )
  }

  const onRedirectCallback = (appState?: { returnTo?: string }) => {
    const returnTo = appState?.returnTo
    if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) return
    const destination = new URL(returnTo, window.location.origin)
    if (destination.origin !== window.location.origin) return
    window.history.replaceState({}, document.title, `${destination.pathname}${destination.search}${destination.hash}`)
  }

  return (
    <Auth0Provider
      domain={config.domain}
      clientId={config.clientId}
      authorizationParams={{
        redirect_uri: `${window.location.origin}/`,
        audience: config.audience,
        scope: 'openid profile email transcribe:run',
      }}
      cacheLocation="memory"
      onRedirectCallback={onRedirectCallback}
    >
      <AuthenticatedContent>{children}</AuthenticatedContent>
    </Auth0Provider>
  )
}

export default function Auth0App({ children }: Auth0AppProps) {
  return <Auth0ProviderWithConfig>{children}</Auth0ProviderWithConfig>
}
