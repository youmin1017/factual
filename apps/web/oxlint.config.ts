import { tanstackConfig } from '@tanstack/oxlint-config'
import { defineConfig } from 'oxlint'

export default defineConfig({
  extends: [tanstackConfig],
  // Not inherited through `extends`
  env: tanstackConfig.env,
  ignorePatterns: [
    ...tanstackConfig.ignorePatterns,
    // Generated files
    'src/routeTree.gen.ts',
    'src/lib/api.gen.ts',
    // shadcn/ui components are vendored (`pnpm dlx shadcn@latest add <name>`);
    // they follow shadcn's conventions, not this config.
    'src/components/ui/**',
  ],
  // The shared config is framework-agnostic; add the React rules. `plugins`
  // replaces the inherited list, so repeat the shared ones.
  plugins: ['import', 'typescript', 'unicorn', 'react'],
  rules: {
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'warn',
    'react/jsx-key': 'error',
  },
})
