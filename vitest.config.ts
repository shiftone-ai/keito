import { defineConfig } from 'vitest/config';

// Tests run on the model and the server's store alone: none of the app's dev-server plugins
// (the boards folder and its watcher would keep the run from ending).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Longer than vitest's 5 s default, which the slowest tests exceed in two places: on the CI runner, about
    // 2.5 times as slow as a dev Mac (4.7 s against 1.8 s), and on a dev Mac running four runs of the suite at
    // once (16 s against 3 s).
    testTimeout: 30_000,
  },
});
