import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const initialRef = useRef(initialValue)

  const readValue = useCallback((): T => {
    if (typeof window === 'undefined') return initialRef.current
    try {
      const item = window.localStorage.getItem(key)
      return item != null ? (JSON.parse(item) as T) : initialRef.current
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error)
      return initialRef.current
    }
  }, [key])

  // Server and first client render must agree or consumers binding this into markup trip hydration warnings.
  // Synced to the real value in a layout effect so client-only mounts (game screens) pick it up before paint.
  const [storedValue, setStoredValue] = useState<T>(initialValue)
  // Mirrors the live value so setValue can resolve the next value synchronously, never from a stale closure.
  const valueRef = useRef(storedValue)
  valueRef.current = storedValue

  useIsoLayoutEffect(() => {
    const nextValue = readValue()
    setStoredValue((prev) => (Object.is(prev, nextValue) ? prev : nextValue))
  }, [readValue])

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        // Resolve now (not inside the updater): React may run the updater lazily, and the persisted value
        // must be the one we actually set, not initialRef. This is what made every write save the default.
        const nextValue = value instanceof Function ? (value as (prev: T) => T)(valueRef.current) : value
        valueRef.current = nextValue
        setStoredValue(nextValue)
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(key, JSON.stringify(nextValue))
        }
      } catch (error) {
        console.warn(`Error setting localStorage key "${key}":`, error)
      }
    },
    [key]
  )

  return [storedValue, setValue]
}
