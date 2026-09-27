import { useEffect, useState } from 'react'

// The theme has three states: a stored 'light' or 'dark' pins it; no stored
// value means "follow the system", and keep following it while the app is open.
// public/theme-boot.js applies the same rule before the first paint.

export type ThemeChoice = 'auto' | 'light' | 'dark'

const KEY = 'isar-theme'
const system = () => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

function stored(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'auto'
  } catch {
    return 'auto'
  }
}

function apply(choice: ThemeChoice) {
  const theme = choice === 'auto' ? system() : choice
  document.documentElement.setAttribute('data-theme', theme)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f7f8fa' : '#0a0c10')
}

/** The current choice and a function that moves to the next one: auto → hell → dunkel → auto. */
export function useTheme(): [ThemeChoice, () => void] {
  const [choice, setChoice] = useState<ThemeChoice>(stored)

  useEffect(() => {
    apply(choice)
    if (choice !== 'auto') return
    const mql = window.matchMedia?.('(prefers-color-scheme: light)')
    const follow = () => apply('auto')
    mql?.addEventListener('change', follow)
    return () => mql?.removeEventListener('change', follow)
  }, [choice])

  function next() {
    const n: ThemeChoice = choice === 'auto' ? 'light' : choice === 'light' ? 'dark' : 'auto'
    try {
      if (n === 'auto') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, n)
    } catch {
      // Private mode: the choice lasts until the tab closes.
    }
    setChoice(n)
  }

  return [choice, next]
}

export const THEME_LABEL: Record<ThemeChoice, string> = {
  auto: 'Design: automatisch',
  light: 'Design: hell',
  dark: 'Design: dunkel',
}
