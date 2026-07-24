// App-level audio mixer + background-music player. Sits above sound.ts (the synth stings) and
// consoleAudio.ts (the device SFX): it owns the two user-facing volumes and the music transport.
// The old per-game synth beds are unlinked (GAME_BEDS_ENABLED in sound.ts); background music now
// comes from mp3 tracks played here. UI-first for now: the playlist is a placeholder until the mp3s
// land. Drop files in web/public/music, list them in TRACKS, and the drawer + player wire up as-is.

import { useSyncExternalStore } from 'react'
import { setSynthSfxVolume } from './sound'
import { setDeviceSfxVolume } from '@/components/console/consoleAudio'

export type Track = { title: string; src: string }

// Placeholder playlist. `src` is empty until the mp3s arrive, so play/next just move the UI without
// touching audio; once a track has a real src it plays normally with no other change needed.
export const TRACKS: Array<Track> = [
  { title: 'Euphoria - INTRO LOW A 1', src: '' },
]

const SFX_KEY = 'pips_sfx_vol'
const MUSIC_KEY = 'pips_music_vol'

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function load(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  const raw = window.localStorage.getItem(key)
  const n = raw == null ? NaN : Number(raw)
  return Number.isFinite(n) ? clamp01(n) : fallback
}

function persist(key: string, value: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // storage can be full or blocked (private mode); the live value still holds this session
  }
}

let sfxVolume = load(SFX_KEY, 1)
let musicVolume = load(MUSIC_KEY, 0.72)
let trackIndex = 0
let playing = false

export type AudioSnapshot = {
  sfxVolume: number
  musicVolume: number
  playing: boolean
  track: Track
  trackIndex: number
  trackCount: number
}

// A cached snapshot so useSyncExternalStore gets a stable reference between real changes.
let snapshot: AudioSnapshot = build()
const listeners = new Set<() => void>()

function build(): AudioSnapshot {
  return {
    sfxVolume,
    musicVolume,
    playing,
    track: TRACKS[trackIndex] ?? { title: 'No track', src: '' },
    trackIndex,
    trackCount: TRACKS.length,
  }
}

function emit(): void {
  snapshot = build()
  for (const l of listeners) l()
}

export function subscribeAudio(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// The single <audio> element for background music, created lazily on the first gesture (a play tap or
// a volume drag) so autoplay policy is never hit.
let el: HTMLAudioElement | null = null
function ensureEl(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null
  if (!el) {
    el = new Audio()
    el.volume = musicVolume
    el.addEventListener('ended', next)
  }
  return el
}

function playCurrent(): void {
  const a = ensureEl()
  const track = TRACKS[trackIndex]
  if (!a || !track?.src) return
  if (!a.src.endsWith(track.src)) a.src = track.src
  a.volume = musicVolume
  a.play().catch(() => {})
}

export function getMusicVolume(): number {
  return musicVolume
}

export function setSfxVolume(v: number): void {
  v = clamp01(v)
  if (v === sfxVolume) return
  sfxVolume = v
  persist(SFX_KEY, sfxVolume)
  setSynthSfxVolume(sfxVolume)
  setDeviceSfxVolume(sfxVolume)
  emit()
}

export function setMusicVolume(v: number): void {
  v = clamp01(v)
  if (v === musicVolume) return
  musicVolume = v
  persist(MUSIC_KEY, musicVolume)
  if (el) el.volume = musicVolume
  emit()
}

export function togglePlay(): void {
  const a = ensureEl()
  if (playing) {
    a?.pause()
    playing = false
  } else {
    playing = true
    playCurrent() // no-op while the track has no src, the UI still flips to playing
  }
  emit()
}

export function next(): void {
  if (TRACKS.length === 0) return
  trackIndex = (trackIndex + 1) % TRACKS.length
  if (playing) playCurrent()
  emit()
}

export function prev(): void {
  if (TRACKS.length === 0) return
  trackIndex = (trackIndex - 1 + TRACKS.length) % TRACKS.length
  if (playing) playCurrent()
  emit()
}

export function useAudioState(): AudioSnapshot {
  return useSyncExternalStore(subscribeAudio, () => snapshot, () => snapshot)
}

// Seed the SFX backends with the persisted volume at import time (before their gain nodes exist, the
// setters just stash the scale and apply it when the node is first created).
setSynthSfxVolume(sfxVolume)
setDeviceSfxVolume(sfxVolume)
