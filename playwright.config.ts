import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// The app's boards go to a folder of their own: never the user's (see server/store.ts).
const boards = mkdtempSync(join(tmpdir(), 'keito-e2e-boards-'));
const PORT = Number(process.env.KEITO_E2E_PORT || 5199);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`KEITO_E2E_PORT must be a port number from 1 to 65535: ${process.env.KEITO_E2E_PORT}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, headless: true },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    env: { KEITO_BOARDS: boards, VITE_KEITO_COLLAB: '1' },
  },
});
