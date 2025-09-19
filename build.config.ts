import { defineBuildConfig } from 'unbuild';

export default defineBuildConfig({
  entries: [
    'src/index',
    'src/adapters/sqljs',
    'src/migrations',
    'src/types',
  ],
  declaration: true,
  clean: true,
  rollup: {
    emitCJS: false,
  },
});

