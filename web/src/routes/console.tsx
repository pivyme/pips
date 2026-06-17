import { createFileRoute } from '@tanstack/react-router'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'

export const Route = createFileRoute('/console')({ component: ConsolePage })

function ConsolePage() {
  return (
    <>
      {/* HTML screen content — z-index below ConsoleCanvas (10) so the device frame sits on top */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            background: '#ffffff',
            width: '28vw',
            aspectRatio: '768 / 1200',
            borderRadius: 4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            fontFamily: 'system-ui, sans-serif',
            color: '#111',
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Screen content goes here</p>
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>HTML overlay test</p>
        </div>
      </div>

      <ConsoleCanvas />
    </>
  )
}
