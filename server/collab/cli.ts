#!/usr/bin/env -S npx tsx
/**
 * The collaboration server and its administration (npm run collab -- …).
 *
 *   serve [--port 1235] [--host 0.0.0.0]        run the server
 *   init <案件名> [--board <ボード名>]            make a shared project (one board, one shape)
 *   grant <案件 id>                              make an editor's credential for the project
 *         [--server ws://…] [--app http://…]    … and print the link that joins it
 *
 * Every command takes --data <folder> (default: $KEITO_COLLAB_DATA, else ./collab-data), the
 * folder holding the SQLite file.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sharedAddress } from '../../src/collab/join';
import { collabServer } from './server';
import { openStore } from './store';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    board: { type: 'string' },
    server: { type: 'string' },
    app: { type: 'string' },
  },
});

const folder = resolve(values.data ?? process.env.KEITO_COLLAB_DATA ?? 'collab-data');
mkdirSync(folder, { recursive: true });
const store = openStore(join(folder, 'keito-collab.sqlite'));
const [command, arg] = positionals;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (command === 'serve') {
  const given = values.port ?? process.env.KEITO_COLLAB_PORT ?? '1235';
  const port = Number(given);
  if (!/^\d+$/.test(given) || port > 65535) fail(`ポート番号が正しくありません: ${given}`);
  const host = values.host ?? process.env.KEITO_COLLAB_HOST;
  const server = collabServer(store, { port, address: host });
  await server.listen();
  // One line, read by whoever started the server (the tests read the port from it).
  console.log(`keito collab listening on ws://${host ?? '0.0.0.0'}:${server.address.port}`);
  const stop = async (): Promise<void> => {
    await server.destroy();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
} else if (command === 'init') {
  if (!arg?.trim()) fail('案件名を指定してください: init <案件名> [--board <ボード名>]');
  const seed = store.initProject({ title: arg.trim(), board: values.board?.trim() || '配置', shape: '図形' });
  store.close();
  console.log(`案件を作りました: ${seed.title}\nproject: ${seed.id}\nboard: ${seed.board.id}`);
} else if (command === 'grant') {
  if (!arg) fail('案件 id を指定してください: grant <案件 id>');
  if (store.projectSchema(arg) === null) fail(`案件 ${arg} はありません（init で作った案件の id を指定してください）`);
  const { id, token } = store.addGrant(arg);
  store.close();
  console.log(`編集の権限を作りました: ${id}\ntoken: ${token}`);
  if (values.server && values.app) console.log(`参加リンク: ${joinLink(values.app, values.server, arg, token)}`);
} else {
  fail('使い方: npm run collab -- serve | init <案件名> | grant <案件 id>');
}

/** The link that opens the project in the app (src/collab/join.ts reads it). */
function joinLink(app: string, server: string, project: string, token: string): string {
  const query = new URLSearchParams({ server, token });
  return `${app.replace(/\/?$/, '/')}${sharedAddress(project)}?${query}`;
}
