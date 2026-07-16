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

  // Server render and the first client render must agree, otherwise any consumer that binds the
  // stored value into markup or styles will trip hydration warnings. We still sync the real value in
  // a layout effect so client-only mounts (like game screens) pick it up before paint.
  const [storedValue, setStoredValue] = useState<T>(initialValue)

  useIsoLayoutEffect(() => {
    const nextValue = readValue()
    setStoredValue((prev) => (Object.is(prev, nextValue) ? prev : nextValue))
  }, [readValue])

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        let nextValue = initialRef.current
        setStoredValue((prev) => {
          nextValue = value instanceof Function ? value(prev) : value
          return nextValue
        })
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
