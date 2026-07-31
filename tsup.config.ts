import { defineConfig } from 'tsup'

// One committed, zero-dependency ESM bundle. The skill ships this file and
// nothing else executable; `node scripts/ultrai18n.mjs` must work with no
// install step, no network, and no npm registry.
export default defineConfig({
  entry: { ultrai18n: 'src/cli.ts' },
  outDir: 'skills/ultrai18n/scripts',
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: false,
  dts: false,
  // Every dependency is vendored into src/vendor. Nothing may be external:
  // an external import would break the no-install guarantee.
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
  esbuildOptions(options) {
    options.legalComments = 'inline'
  },
  async onSuccess() {
    const { chmodSync } = await import('node:fs')
    chmodSync('skills/ultrai18n/scripts/ultrai18n.mjs', 0o755)
  },
})
