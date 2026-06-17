import { createFileRoute } from '@tanstack/react-router'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'

export const Route = createFileRoute('/console')({ component: ConsolePage })

function ConsolePage() {
    return (
        <>
            {/* background — lowest layer */}
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'radial-gradient(circle at 50% 38%, #F4EAD6 0%, #DECDAB 82%)',
                    zIndex: 0,
                }}
            />

            {/* HTML screen content — z-index below ConsoleCanvas (10) so the device frame sits on top */}
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <div
                    style={{
                        background: '#ffffff',
                        width: '17.7vw',
                        height: '90vh',
                        aspectRatio: '760 / 1650',
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
                    <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Hello test</p>
                </div>
            </div>

            <ConsoleCanvas />
        </>
    )
}
