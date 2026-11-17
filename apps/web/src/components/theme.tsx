import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'

const themes = [
  { value: 'dark', label: '深色', icon: MoonIcon },
  { value: 'light', label: '淺色', icon: SunIcon },
  { value: 'system', label: '跟隨系統', icon: MonitorIcon },
] as const

/**
 * Dark by default; the choice is kept in localStorage and applied as the
 * `dark` class on <html> before the first paint.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      storageKey="factual-theme"
    >
      {children}
    </NextThemesProvider>
  )
}

/** The three appearance choices as radio items, for use inside a menu. */
export function ThemeMenuItems() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
      {themes.map(({ value, label, icon: Icon }) => (
        <DropdownMenuRadioItem key={value} value={value}>
          <Icon />
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/** A standalone appearance button, for pages without the app menu. */
export function ThemeToggle() {
  const { resolvedTheme } = useTheme()
  // The resolved theme is only known in the browser.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const Icon = mounted && resolvedTheme === 'light' ? SunIcon : MoonIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="外觀">
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ThemeMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
