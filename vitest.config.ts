import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    env: {
      GROUPS_DIR: path.join(os.tmpdir(), 'nanoclaw-test-groups'),
    },
  },
});
