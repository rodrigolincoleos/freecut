import React, { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import Auth0App from './auth/Auth0App'
import './style.css'

const App = lazy(() => import('./App'))

createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <Suspense fallback={
      <main className="auth-page" aria-live="polite">
        <section className="auth-card">
          <div className="auth-brand"><span className="brand-mark">f</span><span>freecut</span></div>
          <span className="spinner auth-spinner" />
          <p>Abriendo FreeCut…</p>
        </section>
      </main>
    }>
      <Auth0App><App /></Auth0App>
    </Suspense>
  </React.StrictMode>,
)
