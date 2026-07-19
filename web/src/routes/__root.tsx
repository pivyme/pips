import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { Toaster } from 'react-hot-toast'
import { ErrorPage, NotFoundPage } from '../components/FaultScreen'
import LenisSmoothScrollProvider from '../providers/LenisSmoothScrollProvider'
import appCss from '../styles.css?url'
import type { QueryClient } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth'
import { AppPrivyProvider } from '@/lib/privy'

interface MyRouterContext {
  queryClient: QueryClient
}

// Hardcoded prod origin. Social crawlers (Telegram especially) need absolute image
// URLs, so og:image/twitter:image point at the live domain, never a relative path.
const SITE_URL = 'https://playpips.fun'
const OG_IMAGE = `${SITE_URL}/pips-og.jpg`
const OG_TITLE = "World's First Virtual Gamified Trading Console"
const OG_DESC =
  "Built for fun and money. An overkill 3D virtual console to make trading fun and full of eargasm. Attention spans are shrinking, people want more out of every dollar, and trading? It's stressful with candles and order books. What if you just played?"
const OG_IMAGE_ALT = "PIPS, the world's first virtual gamified trading console"

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
      { title: `PIPS · ${OG_TITLE}` },
      { name: 'description', content: OG_DESC },
      // PIPS owns its dark palette. Extension-level recoloring can force the live Canvas/WebGL
      // game surfaces through an expensive full-page filter on every frame.
      { name: 'darkreader-lock', content: '' },
      { name: 'theme-color', content: '#000000' },

      // Standalone / "Add to Home Screen": full-screen launch, no browser chrome. black-translucent
      // goes edge-to-edge under the status bar (the app already pads with env(safe-area-inset-*)).
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { name: 'apple-mobile-web-app-title', content: 'PIPS' },

      // Open Graph (Telegram, iMessage, Discord, Facebook, Slack)
      { property: 'og:site_name', content: 'PIPS' },
      { property: 'og:title', content: OG_TITLE },
      { property: 'og:description', content: OG_DESC },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: SITE_URL },
      { property: 'og:locale', content: 'en_US' },
      { property: 'og:image', content: OG_IMAGE },
      { property: 'og:image:secure_url', content: OG_IMAGE },
      { property: 'og:image:type', content: 'image/jpeg' },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: OG_IMAGE_ALT },

      // Twitter / X (large image card)
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: OG_TITLE },
      { name: 'twitter:description', content: OG_DESC },
      { name: 'twitter:image', content: OG_IMAGE },
      { name: 'twitter:image:alt', content: OG_IMAGE_ALT },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'canonical', href: SITE_URL },
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
        {/* Tint the iOS status-bar strip to the saved skin before first paint, so it never flashes black.
            _app caches the color, "/" clears it. Runs in <head> since body isn't parsed yet (that part lands in _app's effect). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var c=localStorage.getItem('pips_console_backdrop');if(c&&location.pathname!=='/'){document.documentElement.style.background=c;var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=c;}}catch(e){}`,
          }}
        />
      </head>
      <body className="bg-canvas text-text antialiased">
        <LenisSmoothScrollProvider />
        <Toaster
          position="top-center"
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
