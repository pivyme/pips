// App-level audio mixer + background-music player. It owns the two user-facing volumes and the music
// transport. The old per-game synth beds are unlinked (GAME_BEDS_ENABLED in sound.ts); background
// music is one mp3 played here.
//
// Three buses, and only two of them are user-facing:
//   1. Device SFX (consoleAudio.ts) - button, knob, roller. FIXED level, no fader. They are the
//      hardware's own feel, so they always cut through, same as a real handheld's clicks.
//   2. Game sounds (sound.ts) - win, lose, achievement, slot ticks. The sound-effects fader.
//   3. Music (here) - the mp3 bed. Its own fader, capped well under the other two.
//
// The transport skips PARTS of that one track, not tracks. Left alone, playback rolls from part to
// part with no seam (it is a single file) and loops back to the top at the end. Skip forward stops at
// the last part, skip back stops at the first. The whole file is pulled into a blob at boot, so a
// skip or a loop never waits on the network.

import { useSyncExternalStore } from 'react'
import { setSynthSfxVolume } from './sound'

const BGM_SRC = '/sounds/PIPS_BGM.mp3'

// The parts of the track, by start time in seconds (timed off the mix). The transport shows one at a
// time, so it reads like a playlist.
const PARTS = [
  { at: 0, title: 'PIPS - Intro' },
  { at: 32.78, title: 'PIPS - Build' },
  { at: 57.6, title: 'PIPS - Drop' },
  { at: 98.46, title: 'PIPS - Outro' },
]

// The music bus tops out here, not at unity. The mix is hot (~-20 dBFS RMS) and both SFX buses are
// short transients, so a full-scale bed would bury every click. This keeps the fader's whole travel
// under them: even at max, a button press sits well on top.
const MUSIC_CEILING = 0.4

// Where the faders sit by default, and where the drawer's reset puts them back. Tuned against the
// fixed device level so nothing masks anything.
export const RECOMMENDED = { sfx: 1, music: 0.72 }

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

let sfxVolume = load(SFX_KEY, RECOMMENDED.sfx)
let musicVolume = load(MUSIC_KEY, RECOMMENDED.music)
let playing = false
let partIndex = 0

export type AudioSnapshot = {
  sfxVolume: number
  musicVolume: number
  playing: boolean
  title: string
  isFirstPart: boolean
  isLastPart: boolean
}

// A cached snapshot so useSyncExternalStore gets a stable reference between real changes.
let snapshot: AudioSnapshot = build()
const listeners = new Set<() => void>()

function build(): AudioSnapshot {
  return {
    sfxVolume,
    musicVolume,
    playing,
    title: PARTS[partIndex].title,
    isFirstPart: partIndex === 0,
    isLastPart: partIndex === PARTS.length - 1,
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

// musicVolume is the fader position (0..1); the element only ever hears it through the ceiling.
function applyVolume(): void {
  if (el) el.volume = musicVolume * MUSIC_CEILING
}

function partAt(t: number): number {
  let i = 0
  while (i + 1 < PARTS.length && t >= PARTS[i + 1].at) i++
  return i
}

// Pull the file down once and hand the element a local blob. iOS ignores <audio preload> until a
// gesture, but a plain fetch is not blocked, so the bytes are already here when play is first tapped.
let blobUrl: string | null = null
let warming: Promise<void> | null = null
function warm(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (!warming) {
    warming = fetch(BGM_SRC)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`bgm ${r.status}`))))
      .then((b) => {
        blobUrl = URL.createObjectURL(b)
        // Only swap an untouched element: re-pointing src mid-track would gap the audio, and by now
        // the network url is in the http cache anyway.
        if (el && el.paused && el.currentTime === 0 && !el.src.startsWith('blob:')) {
          el.src = blobUrl
          el.load()
        }
      })
      .catch(() => {
        warming = null // transient; the element still streams from the url and a later play retries
      })
  }
  return warming
}

let el: HTMLAudioElement | null = null
function ensureEl(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null
  if (el) return el
  const a = new Audio()
  a.preload = 'auto'
  a.loop = true // the end runs straight back to the top
  a.volume = musicVolume * MUSIC_CEILING
  // play/pause events (not our own calls) drive the flag, so an OS interrupt stays in sync
  a.addEventListener('play', () => {
    if (!playing) {
      playing = true
      emit()
    }
  })
  a.addEventListener('pause', () => {
    if (playing) {
      playing = false
      emit()
    }
  })
  a.addEventListener('timeupdate', () => {
    const i = partAt(a.currentTime)
    if (i !== partIndex) {
      partIndex = i
      emit()
    }
  })
  a.src = blobUrl ?? BGM_SRC
  a.load()
  el = a
  return a
}

export function getMusicVolume(): number {
  return musicVolume
}

// Scales the game stings only. Device SFX are fixed, see the header.
export function setSfxVolume(v: number): void {
  v = clamp01(v)
  if (v === sfxVolume) return
  sfxVolume = v
  persist(SFX_KEY, sfxVolume)
  setSynthSfxVolume(sfxVolume)
  emit()
}

export function setMusicVolume(v: number): void {
  v = clamp01(v)
  if (v === musicVolume) return
  musicVolume = v
  persist(MUSIC_KEY, musicVolume)
  applyVolume()
  emit()
}

export function resetVolumes(): void {
  setSfxVolume(RECOMMENDED.sfx)
  setMusicVolume(RECOMMENDED.music)
}

export function togglePlay(): void {
  const a = ensureEl()
  if (!a) return
  if (playing) a.pause()
  else void a.play().catch(() => {}) // blocked autoplay just leaves the transport paused
}

function seekPart(idx: number): void {
  const a = ensureEl()
  if (!a) return
  try {
    a.currentTime = PARTS[idx].at
  } catch {
    // seeking before metadata lands; the src position takes it from here
  }
  partIndex = idx
  emit()
  if (playing) void a.play().catch(() => {})
}

export function next(): void {
  if (partIndex >= PARTS.length - 1) return // last part, nothing after it
  seekPart(partIndex + 1)
}

export function prev(): void {
  if (partIndex <= 0) return // first part, nothing before it
  seekPart(partIndex - 1)
}

export function useAudioState(): AudioSnapshot {
  return useSyncExternalStore(subscribeAudio, () => snapshot, () => snapshot)
}

// Seed the sting bus with the persisted volume at import time (before its gain node exists, the
// setter just stashes the scale and applies it when the node is first created).
setSynthSfxVolume(sfxVolume)

// Fetch the track once the boot is out of the way, so ~1.8MB never competes with the first paint or
// the 3D scene. Pressing play earlier still works, it just streams from the url that first time.
if (typeof window !== 'undefined') {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => void warm(), { timeout: 4000 })
  } else {
    window.setTimeout(() => void warm(), 2000) // Safari < 18.4
  }
}
