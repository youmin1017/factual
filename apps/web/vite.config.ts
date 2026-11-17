import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev: forward /api/* to the Go backend (FACTUAL_API_PROXY_TARGET, default :8080).
const apiTarget =
  process.env.FACTUAL_API_PROXY_TARGET || 'http://localhost:8080'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    proxy: {
      '/api': { target: apiTarget },
    },
  },
  plugins: [
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
