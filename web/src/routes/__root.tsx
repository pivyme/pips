import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { Toaster } from 'react-hot-toast'
import ErrorPage from '../components/ErrorPage'
import NotFoundPage from '../components/NotFoundPage'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import appCss from '../styles.css?url'
import type { QueryClient } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth'
import { AppPrivyProvider } from '@/lib/privy'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  notFoundComponent: () => <NotFoundPage />,
  errorComponent: ({ error, reset }) => <ErrorPage error={error} reset={reset} />,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content:
          'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
      },
      { title: 'PIPS' },
      {
        name: 'description',
        content:
          'PIPS makes trading simple, intuitive, and addictive, like a game. A gamified trading console on Sui.',
      },
      // PIPS owns its dark palette. Extension-level recoloring can force the live Canvas/WebGL
      // game surfaces through an expensive full-page filter on every frame.
      { name: 'darkreader-lock', content: '' },
      { name: 'theme-color', content: '#000000' },
      // Social previews
      { property: 'og:title', content: 'PIPS' },
      {
        property: 'og:description',
        content: 'Trading made simple, intuitive, and addictive, like a game.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:image', content: '/assets/logos/pips-512.png' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: 'PIPS' },
      {
        name: 'twitter:description',
        content: 'Trading made simple, intuitive, and addictive, like a game.',
      },
      { name: 'twitter:image', content: '/assets/logos/pips-512.png' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      // Favicon + app icons, all the 3D PIPS mark. PNG for crisp modern rendering, .ico legacy fallback.
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/assets/logos/pips-32.png' },
      { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/assets/logos/pips-192.png' },
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48 32x32 16x16' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'manifest', href: '/manifest.json' },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Tint the iOS status-bar strip to the saved skin before first paint, so it never flashes
            black on load. _app caches the color; the door ("/") clears it. Runs in <head>, so it can
            touch the theme-color meta + html bg (body isn't parsed yet, that lands in _app's effect). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var c=localStorage.getItem('pips_console_backdrop');if(c&&location.pathname!=='/'){document.documentElement.style.background=c;var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=c;}}catch(e){}`,
          }}
        />
      </head>
      <body className="bg-canvas text-text antialiased">
        <LenisSmoothScrollProvider />
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: {
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-line-strong)',
              borderRadius: '14px',
              fontSize: '14px',
              fontWeight: 600,
              fontFamily: '"Gabarito Variable", ui-sans-serif, sans-serif',
            },
            // secondary is the icon-internal cutout color (no semantic token); primary tracks the brand/down tokens.
            success: { iconTheme: { primary: 'var(--color-brand-500)', secondary: '#1a1200' } },
            error: { iconTheme: { primary: 'var(--color-down)', secondary: 'white' } },
          }}
        />
        <AuthProvider>
          <AppPrivyProvider>{children}</AppPrivyProvider>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  )
}
