#!/usr/bin/env -S npx tsx
/**
 * The collaboration server and its administration (npm run collab -- …).
 *
 *   serve [--port 1235] [--host 0.0.0.0]        run the server
 *   init <案件名> [--board <ボード名>]            make a shared project (one board, one shape)
 *        [--kind system|software|free]           … the kind of board (default: free)
 *   invite <案件 id> --role viewer|editor        make an invite to the project, to see it or edit it too
 *          [--server ws://…] [--app http://…]   … and print the link that joins it
 *   invites <案件 id>                            list the project's invites
 *   revoke <招待 id>                             revoke an invite (its clients are let go)
 *   delete <案件 id>                             delete the project (its clients are let go)
 *   restore <案件 id>                            bring a deleted project back as it was
 *
 * Every command takes --data <folder> (default: $KEITO_COLLAB_DATA, else ./collab-data), the
 * folder holding the SQLite file and the projects' pictures (pictures/). Whoever can open that folder administers every project in it:
 * nobody else may (see docs/development.md), and no command runs while anyone else can.
 */
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sharedAddress } from '../../src/collab/join';
import { type Role, isRole } from '../../src/collab/protocol';
import { type BoardKind, KIND_ORDER } from '../../src/model/kinds';
import { pictureStore } from './pictureStore';
import { collabServer } from './server';
import { openStore } from './store';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    board: { type: 'string' },
    kind: { type: 'string' },
    server: { type: 'string' },
    app: { type: 'string' },
    role: { type: 'string' },
  },
});

/** What the administration commands call each role. */
const ROLES: Record<Role, string> = { viewer: '閲覧', editor: '編集' };

/** The kinds of board a new shared project may begin with: a sequence board has no shapes to share yet. */
const INIT_KINDS: readonly BoardKind[] = KIND_ORDER.filter((k) => k !== 'sequence');
const isInitKind = (kind: string): kind is BoardKind => INIT_KINDS.includes(kind as BoardKind);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const folder = resolve(values.data ?? process.env.KEITO_COLLAB_DATA ?? 'collab-data');
mkdirSync(folder, { recursive: true, mode: 0o700 });
// Windows keeps no such bits: there the folder's ACL is the administrator's to set.
if (process.platform !== 'win32' && statSync(folder).mode & 0o077) fail(`データのフォルダを、ほかのユーザーも開けます: ${folder}\n持ち主だけが開けるようにしてから実行してください: chmod 700 ${folder}`);
const store = openStore(join(folder, 'keito-collab.sqlite'));
const [command, arg] = positionals;

if (command === 'serve') {
  const given = values.port ?? process.env.KEITO_COLLAB_PORT ?? '1235';
  const port = Number(given);
  if (!/^\d+$/.test(given) || port > 65535) fail(`ポート番号が正しくありません: ${given}`);
  const host = values.host ?? process.env.KEITO_COLLAB_HOST;
  const server = collabServer(store, { port, address: host, pictures: pictureStore(join(folder, 'pictures')) });
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
  if (!arg?.trim()) fail(`案件名を指定してください: init <案件名> [--board <ボード名>] [--kind ${INIT_KINDS.join('|')}]`);
  const kind = values.kind ?? 'free';
  if (!isInitKind(kind)) fail(`ボードの種類が正しくありません: ${kind}（${INIT_KINDS.join('・')} のどれか）`);
  const seed = store.initProject({ title: arg.trim(), board: values.board?.trim() || '配置', shape: '図形', kind });
  store.close();
  console.log(`案件を作りました: ${seed.title}\nproject: ${seed.id}\nboard: ${seed.board.id}`);
} else if (command === 'invite') {
  const id = project(arg);
  const { role } = values;
  if (!isRole(role)) fail(`権限を指定してください: invite <案件 id> --role viewer（閲覧だけ）か --role editor（編集も）`);
  const grant = store.addGrant(id, role);
  store.close();
  console.log(`${ROLES[role]}の招待を作りました: ${grant.id}\ntoken: ${grant.token}`);
  if (values.server && values.app) console.log(`参加リンク: ${joinLink(values.app, values.server, id, grant.token)}`);
} else if (command === 'invites') {
  const id = project(arg);
  const grants = store.grants(id);
  store.close();
  for (const g of grants) console.log([g.id, ROLES[g.role], `作成 ${g.created}`, ...(g.revoked ? [`取り消し ${g.revoked}`] : [])].join('  '));
  if (!grants.length) console.log(`案件 ${id} の招待はありません`);
} else if (command === 'revoke') {
  if (!arg) fail('招待 id を指定してください: revoke <招待 id>（invites <案件 id> で一覧できます）');
  if (!store.revokeGrant(arg)) fail(`取り消せる招待 ${arg} はありません（取り消し済みか、id が違います）`);
  store.close();
  console.log(`招待を取り消しました: ${arg}\n（この招待で開いている画面は、1 秒ほどで接続を切られます）`);
} else if (command === 'delete') {
  const id = project(arg);
  if (!store.deleteProject(id)) fail(`案件 ${id} は削除済みです`);
  store.close();
  console.log(`案件を削除しました: ${id}\n（restore ${id} で元に戻せます）`);
} else if (command === 'restore') {
  const id = project(arg);
  if (!store.restoreProject(id)) fail(`案件 ${id} は削除されていません`);
  store.close();
  console.log(`案件を元に戻しました: ${id}`);
} else {
  fail('使い方: npm run collab -- serve | init <案件名> | invite <案件 id> --role viewer|editor | invites <案件 id> | revoke <招待 id> | delete <案件 id> | restore <案件 id>');
}

/** The project id given to a command, once it is known to be one that `init` made. */
function project(id: string | undefined): string {
  if (!id) fail(`案件 id を指定してください: ${command} <案件 id>`);
  if (store.projectSchema(id) === null) fail(`案件 ${id} はありません（init で作った案件の id を指定してください）`);
  return id;
}

/** The link that opens the project in the app (src/collab/join.ts reads it). */
function joinLink(app: string, server: string, project: string, token: string): string {
  const query = new URLSearchParams({ server, token });
  return `${app.replace(/\/?$/, '/')}${sharedAddress(project)}?${query}`;
}
