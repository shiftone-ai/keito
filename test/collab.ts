import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openStore } from '../server/collab/store';
import type { ProjectSeed } from '../src/collab/model';

/** A new data folder for the collaboration server, holding one project and an editor's credential for it. */
export function seedData(): { data: string; seed: ProjectSeed; token: string } {
  const data = mkdtempSync(join(tmpdir(), 'keito-collab-'));
  const store = openStore(join(data, 'keito-collab.sqlite'));
  try {
    const seed = store.initProject({ title: '共有テスト', board: '配置', shape: '図形' });
    return { data, seed, token: store.addGrant(seed.id).token };
  } finally {
    store.close();
  }
}

export interface RunningServer {
  /** Where clients connect: ws://127.0.0.1:<port>. */
  url: string;
  /** Kill the process outright (SIGKILL): nothing it holds in memory is stored on the way out. */
  kill(): Promise<void>;
}

/** Run the collaboration server as its own process on a free port, over the SQLite file in `data`. */
export async function startServer(data: string, port = 0): Promise<RunningServer> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/collab/cli.ts', 'serve', '--data', data, '--host', '127.0.0.1', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! });
  const listening = new Promise<number>((resolve, reject) => {
    lines.on('line', (line) => {
      const m = /listening on .*:(\d+)$/.exec(line);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`collab server exited (${code})`)));
  });
  const actual = await listening;
  return {
    url: `ws://127.0.0.1:${actual}`,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}

/** Wait until `check` holds (checked every 20 ms), or fail after `ms`. */
export async function until(check: () => boolean, ms = 5_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
