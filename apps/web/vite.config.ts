import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// Dev: forward /api/* to the Go backend (FACTUAL_API_PROXY_TARGET, default :8080).
const apiTarget =
  process.env.FACTUAL_API_PROXY_TARGET || 'http://localhost:8080'

/**
 * Simple Icons for the login providers (ADR-125), as files: one per icon at
 * /brand-icons/<slug>.svg and the slugs in /brand-icons/index.json. A page
 * fetches the icons it shows; the bundle holds none of them.
 */
function brandIcons(): Plugin {
  const dir = path.join(import.meta.dirname, 'node_modules/simple-icons/icons')
  const slugs = () =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -'.svg'.length))
  return {
    name: 'factual:brand-icons',
    configureServer(server) {
      server.middlewares.use('/brand-icons/', (req, res, next) => {
        const name = (req.url ?? '').slice(1).split('?')[0]
        if (name === 'index.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(slugs()))
          return
        }
        if (!/^[a-z0-9_]+\.svg$/.test(name)) return next()
        try {
          const svg = readFileSync(path.join(dir, name))
          res.setHeader('Content-Type', 'image/svg+xml')
          res.end(svg)
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
    generateBundle() {
      if (this.environment.name !== 'client') return
      const list = slugs()
      for (const slug of list)
        this.emitFile({
          type: 'asset',
          fileName: `brand-icons/${slug}.svg`,
          source: readFileSync(path.join(dir, `${slug}.svg`)),
        })
      this.emitFile({
        type: 'asset',
        fileName: 'brand-icons/index.json',
        source: JSON.stringify(list),
      })
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    proxy: {
      '/api': { target: apiTarget },
    },
  },
  plugins: [
    brandIcons(),
    devtools(),
    tailwindcss(),
    // The app sits behind a login and talks to the Go API: build a static SPA
    // (dist/client, entry `_shell.html`) instead of a Node server.
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
})

export default config
