#!/usr/bin/env -S npx tsx
/**
 * The collaboration server and its administration (npm run collab -- …).
 *
 *   serve [--port 1235] [--host 0.0.0.0]        run the server
 *         [--pictures-per-project 10GB]         … the most a project's pictures take together
 *         [--min-free-disk 5GB]                 … the free space a picture kept leaves on the disk
 *         [--keep-unused-pictures 30d]          … how long a picture no board uses is kept
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
    'pictures-per-project': { type: 'string' },
    'min-free-disk': { type: 'string' },
    'keep-unused-pictures': { type: 'string' },
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

/** The units a size and a period given to `serve` are written in, in bytes and in milliseconds. */
const BYTES = { '': 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const MILLISECONDS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

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
  const perProject = values['pictures-per-project'] ?? process.env.KEITO_COLLAB_PICTURES_PER_PROJECT ?? '10GB';
  const minFree = values['min-free-disk'] ?? process.env.KEITO_COLLAB_MIN_FREE_DISK ?? '5GB';
  const keepUnused = values['keep-unused-pictures'] ?? process.env.KEITO_COLLAB_KEEP_UNUSED_PICTURES ?? '30d';
  const limits = {
    perProject: amountOf(perProject, BYTES) ?? fail(`案件ごとの画像の合計の上限が正しくありません: ${perProject}（例: 10GB・500MB）`),
    minFree: amountOf(minFree, BYTES) ?? fail(`ディスクの空きの下限が正しくありません: ${minFree}（例: 5GB・500MB）`),
  };
  const keepUnusedMs = amountOf(keepUnused, MILLISECONDS) ?? 0;
  if (keepUnusedMs < MILLISECONDS.s) fail(`使われない画像を消すまでの期間が正しくありません: ${keepUnused}（例: 30d・12h。1 秒以上）`);
  const server = collabServer(store, { port, address: host, pictures: pictureStore(join(folder, 'pictures'), limits), keepUnusedMs });
  await server.listen();
  console.log(`画像: 案件ごとの合計 ${perProject} まで・ディスクの空き ${minFree} を残す・使われない画像は ${keepUnused} で消す`);
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

/** A number given with one of `units` (10GB, 1.5GB, 30d) as so many of what the units are counted in; null for anything else. */
function amountOf(given: string, units: Record<string, number>): number | null {
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(given);
  return m && Object.hasOwn(units, m[2]) ? Math.round(Number(m[1]) * units[m[2]]) : null;
}

/** The link that opens the project in the app (src/collab/join.ts reads it). */
function joinLink(app: string, server: string, project: string, token: string): string {
  const query = new URLSearchParams({ server, token });
  return `${app.replace(/\/?$/, '/')}${sharedAddress(project)}?${query}`;
}
