import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { type CollabStore, openStore } from '../server/collab/store';
import type { DeviceStore, KeptProject } from '../src/collab/kept';
import type { ProjectSeed } from '../src/collab/model';
import type { Doc } from '../src/model/types';

/** A new data folder for the collaboration server, holding one project and an editor's credential for it. */
export function seedData(kind?: Doc['kind']): { data: string; seed: ProjectSeed; token: string } {
  const data = mkdtempSync(join(tmpdir(), 'keito-collab-'));
  const store = openStore(join(data, 'keito-collab.sqlite'));
  try {
    const seed = store.initProject({ title: '共有テスト', board: '配置', shape: '図形', kind });
    return { data, seed, token: store.addGrant(seed.id).token };
  } finally {
    store.close();
  }
}

/** How many edits the server has stored of `project` in `data`, read without holding the server off. */
export function storedEdits(data: string, project: string): number {
  const db = new DatabaseSync(join(data, 'keito-collab.sqlite'), { readOnly: true });
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM ops WHERE project = ?').get(project)!.n);
  } finally {
    db.close();
  }
}

/** Do to the projects in `data` what the administration commands (npm run collab) do, while the server runs. */
export function administer<T>(data: string, fn: (store: CollabStore) => T): T {
  const store = openStore(join(data, 'keito-collab.sqlite'));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

export interface RunningServer {
  /** Where clients connect: ws://127.0.0.1:<port>. */
  url: string;
  /** The port it listens on, to start it again where its clients reconnect. */
  port: number;
  /** Kill the process outright (SIGKILL): nothing it holds in memory is stored on the way out. */
  kill(): Promise<void>;
}

/**
 * Run the collaboration server as its own process on a free port, over the SQLite file in `data`.
 * With `output`, every line the server prints (stdout and stderr) is pushed there instead of shown.
 */
export async function startServer(data: string, port = 0, output?: string[]): Promise<RunningServer> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/collab/cli.ts', 'serve', '--data', data, '--host', '127.0.0.1', '--port', String(port)], {
    stdio: ['ignore', 'pipe', output ? 'pipe' : 'inherit'],
  });
  const lines = createInterface({ input: child.stdout! });
  if (output) createInterface({ input: child.stderr! }).on('line', (line) => output.push(line));
  const listening = new Promise<number>((resolve, reject) => {
    lines.on('line', (line) => {
      output?.push(line);
      const m = /listening on .*:(\d+)$/.exec(line);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`collab server exited (${code})`)));
  });
  const actual = await listening;
  return {
    url: `ws://127.0.0.1:${actual}`,
    port: actual,
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

/**
 * What a device keeps of shared projects, held in memory as a browser holds IndexedDB across reloads:
 * hand the same one to the editor of a page opened again. While `failing` is set, every write fails with it.
 */
export function memoryDevice() {
  const kept = new Map<string, KeptProject>();
  const device = { kept, failing: null as Error | null };
  const store: DeviceStore = {
    load: async (key) => structuredClone(kept.get(key) ?? null),
    async change(key, edit) {
      await Promise.resolve();
      if (device.failing) throw device.failing;
      const next = edit(structuredClone(kept.get(key) ?? null));
      if (next) kept.set(key, structuredClone(next));
      else kept.delete(key);
    },
  };
  return Object.assign(device, { store });
}

export interface Relay {
  /** Where clients connect instead of the server. */
  url: string;
  /** Garbled, each message is held up by up to 40 ms (so some overtake others) and one in four is sent twice. */
  garble(on: boolean): void;
  /** Close every connection, and turn new ones away until `reopen`: the clients are offline. */
  cut(): void;
  reopen(): void;
  /** How many messages were sent twice, and how many passed one sent before them on the same connection. */
  garbled(): { twice: number; overtaking: number };
  close(): Promise<void>;
}

/** A relay of whole WebSocket messages between clients and `target`, which can garble or cut what passes; the same `seed`, the same garbling. */
export async function startRelay(target: string, seed = 1): Promise<Relay> {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  const sockets = new Set<WebSocket>();
  let garbled = false;
  let open = true;
  let state = seed;
  const random = (): number => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const counts = { twice: 0, overtaking: 0 };

  relay.on('connection', (client, request) => {
    if (!open) return client.terminate();
    const server = new WebSocket(target + (request.url ?? ''));
    sockets.add(client).add(server);
    const end = (): void => {
      for (const socket of [client, server]) {
        socket.terminate();
        sockets.delete(socket);
      }
    };
    for (const socket of [client, server]) socket.on('close', end).on('error', end);
    const reached = new Promise<void>((resolve) => server.once('open', () => resolve()));
    const pass = (to: WebSocket, ready: Promise<void>) => {
      let came = 0;
      let latest = 0;
      return (data: RawData, binary: boolean) => {
        const n = ++came;
        const send = (): void =>
          void ready.then(() => {
            if (to.readyState !== WebSocket.OPEN) return;
            if (n < latest) counts.overtaking++;
            latest = Math.max(latest, n);
            to.send(data, { binary });
          });
        if (!garbled) return send();
        const times = random() < 0.25 ? 2 : 1;
        if (times === 2) counts.twice++;
        for (let i = 0; i < times; i++) setTimeout(send, Math.floor(random() * 40));
      };
    };
    client.on('message', pass(server, reached));
    server.on('message', pass(client, Promise.resolve()));
  });

  const address = relay.address();
  return {
    url: `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    garble: (on) => void (garbled = on),
    cut() {
      open = false;
      for (const socket of sockets) socket.terminate();
    },
    reopen: () => void (open = true),
    garbled: () => ({ ...counts }),
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
}
