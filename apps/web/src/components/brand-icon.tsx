import { KeyRoundIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '#/lib/utils'

// Brand icons from Simple Icons (ADR-125), for the login providers. The
// build serves every icon as /brand-icons/<slug>.svg and their slugs as
// /brand-icons/index.json (the brandIcons plugin in vite.config.ts), so the
// login page fetches only its buttons' icons and the bundle holds none.
// Drawn in the text colour, as the theme has it.

const SLUG = /^[a-z0-9_]{1,64}$/

/** Path data of icons fetched so far by slug; null for one there is not. */
const paths = new Map<string, Promise<string | null>>()

function iconPath(slug: string): Promise<string | null> {
  let p = paths.get(slug)
  if (!p) {
    p = fetch(`/brand-icons/${slug}.svg`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((svg) => /<path d="([^"]+)"/.exec(svg)?.[1] ?? null)
      .catch(() => null)
    paths.set(slug, p)
  }
  return p
}

/**
 * A provider's icon: the Simple Icons glyph of `slug`, or a key for none
 * (or one that does not exist).
 */
export function BrandIcon({
  slug,
  className,
}: {
  slug: string
  className?: string
}) {
  const [fetched, setFetched] = useState<{ slug: string; d: string } | null>(
    null,
  )
  const d = fetched?.slug === slug ? fetched.d : undefined
  useEffect(() => {
    if (!SLUG.test(slug)) return
    let live = true
    void iconPath(slug).then((path) => {
      if (live && path) setFetched({ slug, d: path })
    })
    return () => {
      live = false
    }
  }, [slug])

  if (!d)
    return (
      <KeyRoundIcon aria-hidden className={cn('size-4 shrink-0', className)} />
    )
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn('size-4 shrink-0', className)}
    >
      <path d={d} />
    </svg>
  )
}

let slugList: Promise<ReadonlySet<string>> | null = null

/** Every Simple Icons slug there is; null until fetched (or when it cannot be). */
export function useIconSlugs(): ReadonlySet<string> | null {
  const [slugs, setSlugs] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    slugList ??= fetch('/brand-icons/index.json')
      .then((r) => (r.ok ? (r.json() as Promise<Array<string>>) : []))
      .then((list) => new Set(list))
      .catch(() => {
        slugList = null
        return new Set<string>()
      })
    let live = true
    void slugList.then((set) => {
      if (live && set.size > 0) setSlugs(set)
    })
    return () => {
      live = false
    }
  }, [])
  return slugs
}
