// Hand-drawn brand marks for the linked-accounts rows (no brand icons in lucide yet). Mirrors the
// *Glyph pattern in components/console/LandingOverlay.tsx (e.g. TelegramGlyph).

export function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.44c-.28 1.48-1.13 2.74-2.4 3.58v3h3.86c2.26-2.08 3.62-5.15 3.62-8.77Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.86-3c-1.07.72-2.44 1.15-4.09 1.15-3.14 0-5.8-2.12-6.75-4.96H1.27v3.11C3.25 21.3 7.28 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.25 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.27a12 12 0 0 0 0 10.8l3.98-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0 7.28 0 3.25 2.7 1.27 6.6l3.98 3.11C6.2 6.87 8.86 4.77 12 4.77Z"
      />
    </svg>
  )
}

export function XGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231ZM17.083 19.77h1.833L7.084 4.126H5.117Z" />
    </svg>
  )
}

// The green verified checkmark, sized to sit next to a handle or in the "Verified" pill.
export function XBadgeGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path
        d="M7.5 12.4 10.3 15.2 16.5 8.6"
        stroke="#04110c"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
