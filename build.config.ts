import { defineBuildConfig } from 'unbuild';

export default defineBuildConfig({
  declaration: true,
  clean: true,
  externals: ['esbuild', 'pnpapi', 'sql.js', 'drizzle-orm', '@libsql/client', 'pg'],
  rollup: {
    emitCJS: false,
    inlineDependencies: false
  },
  entries: [
    { input: 'src/index', outDir: 'dist' },
    { input: 'src/storage/server', outDir: 'dist', name: 'server' },
    { input: 'src/storage/client', outDir: 'dist', name: 'client' },
    { input: 'src/next-js', outDir: 'dist', name: 'next-js' },
    { input: 'src/cli', outDir: 'dist', name: 'cli' },
    { input: 'src/adapters/drizzle', outDir: 'dist', name: 'adapters/drizzle' },
    { input: 'src/adapters/prisma', outDir: 'dist', name: 'adapters/prisma' },
    { input: 'src/adapters/libsql', outDir: 'dist', name: 'adapters/libsql' },
    { input: 'src/adapters/postgres', outDir: 'dist', name: 'adapters/postgres' }
  ],
  failOnWarn: true
})
