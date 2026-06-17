import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import { Toaster } from 'react-hot-toast'
import ErrorPage from '../components/ErrorPage'
import NotFoundPage from '../components/NotFoundPage'
import { AuthProvider } from '@/lib/auth'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

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
      { title: 'Pips' },
      {
        name: 'description',
        content:
          'Pips makes trading simple, intuitive, and addictive, like a game. A gamified trading console on Sui.',
      },
      { name: 'theme-color', content: '#000000' },
      // Social previews
      { property: 'og:title', content: 'Pips' },
      {
        property: 'og:description',
        content: 'Trading made simple, intuitive, and addictive, like a game.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:image', content: '/assets/logos/pips-512.png' },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: 'Pips' },
      {
        name: 'twitter:description',
        content: 'Trading made simple, intuitive, and addictive, like a game.',
      },
      { name: 'twitter:image', content: '/assets/logos/pips-512.png' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      // Favicon + app icons. SVG first for crisp scaling, .ico as the legacy fallback.
      { rel: 'icon', type: 'image/svg+xml', href: '/assets/logos/pips-yellow-quare.svg' },
      { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
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
        <AuthProvider>{children}</AuthProvider>
        <Scripts />
      </body>
    </html>
  )
}
