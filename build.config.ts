import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  declaration: true,
  clean: true,
  externals: ['esbuild', 'pnpapi', 'sql.js'],
  rollup: {
    emitCJS: false,
    inlineDependencies: false
  },
  entries: [
    { input: 'src/index', outDir: 'dist' },
    { input: 'src/storage/server', outDir: 'dist', name: 'server' },
    { input: 'src/storage/client', outDir: 'dist', name: 'client' },
    { input: 'src/next-js', outDir: 'dist', name: 'next-js' },
    { input: 'src/sveltekit', outDir: 'dist', name: 'sveltekit' },
    { input: 'src/cli', outDir: 'dist', name: 'cli' }
  ]
})
