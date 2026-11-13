import { ProjectMenu } from './ProjectMenu';
import { fromYaml } from '../model/dsl';
import { SHARED_SO_FAR } from '../collab/scope';
import { randomId } from '../model/ids';
import { type CollabState, type State, emptyDoc, saveNow, useStore, useTakes } from '../model/store';
import { tidy } from '../model/tidy';
import { kindOf } from '../model/kinds';
import { openComments } from '../model/comments';
import { openBoards } from './Boards';
import { ICON } from './icons';
import type { Doc } from '../model/types';
import { inlineImages, safeName } from '../platform/storage';
import { ask, pickTextFile, saveFile, shortcuts, tell } from '../platform/io';
import { startUpdate, useUpdate } from '../platform/update';

/** Export the board as one self-contained file, pictures included. */
export async function saveBoardFile(): Promise<void> {
  const doc = await inlineImages(useStore.getState().doc);
  await saveFile(`${safeName(doc.meta.title)}.keito.json`, JSON.stringify(doc, null, 2), 'application/json');
}

async function openFile(): Promise<void> {
  const f = await pickTextFile('.json,.yaml,.yml');
  if (!f) return;
  try {
    let doc: Doc;
    if (/\.ya?ml$/i.test(f.name)) {
      doc = fromYaml(f.text, emptyDoc(f.name.replace(/\.ya?ml$/i, '')));
    } else {
      doc = JSON.parse(f.text) as Doc;
      if (doc.version !== 1 || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw new Error('keito のファイルではありません');
    }
    // An opened file becomes a board of its own rather than replacing one that shares its id.
    if (useStore.getState().boards.some((b) => b.id === doc.id)) doc = { ...doc, id: randomId() };
    useStore.getState().newBoard(doc);
  } catch (e) {
    void tell(`開けませんでした: ${e instanceof Error ? e.message : e}`);
  }
}

/** A newer version of the app, when one is found (the desktop app): one press updates to it. */
function UpdateButton() {
  const { update, phase, share } = useUpdate();
  if (!update) return null;
  const label =
    phase === 'downloading' ? `ダウンロード中…${share == null ? '' : ` ${Math.round(share * 100)}%`}`
    : phase === 'installing' ? 'アップデート中…'
    : phase === 'restarting' ? '再起動中…'
    : phase === 'offered' ? `${update.version} にアップデート`
    : `再起動して ${update.version} に`;
  const working = phase === 'downloading' || phase === 'installing' || phase === 'restarting';
  return (
    <button className="update-btn" disabled={working} onClick={() => void startUpdate()} data-tip={phase === 'offered' ? `新しい keito ${update.version} があります。ダウンロードして、ボードを保存してから再起動します` : 'ボードを保存してから再起動して、新しい版にします'}>
      {ICON.update}
      {label}
    </button>
  );
}

/** Shown with a viewer's state: the board is there to look at. */
const LOOK = (
  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10z" />
    <circle cx="10" cy="10" r="2.5" />
  </svg>
);

/**
 * The save state of a shared project's board: saved once the collaboration server has stored the
 * edits, not when it has them; until then, whether this device keeps them. A viewer, who saves
 * nothing, is shown that it only looks, and whether it is connected.
 */
function SharedSaveState({ collab, saving, saveError, project }: { collab: CollabState; saving: State['saving']; saveError: string | null; project: string }) {
  const { pending, link, device, unkept } = collab;
  if (collab.role === 'viewer')
    return (
      <span className="save-state viewer" title={`共有中の案件「${project}」`}>
        {LOOK}
        閲覧のみ{link === 'online' ? '' : link === 'offline' ? '・オフライン' : '・接続中…'}
      </span>
    );
  const shared = `共有中の案件「${project}」（試験中: ${SHARED_SO_FAR}を共有します）`;
  const [text, tip] = unkept
    ? ['本端末に保存できていません', saveError ?? '理由は不明']
    : saving === 'error'
      ? ['共同編集先に保存できていません', `理由: ${saveError ?? '不明'}\n少しずつ間をあけて自動でやり直しています。`]
      : pending && link !== 'online'
        ? [`オフライン・未送信 ${pending} 件`, shared]
        : [pending ? '共同編集先に保存中…' : link !== 'online' ? 'オフライン' : '共同編集先に保存済み', shared];
  const note = unkept
    ? `閉じると未送信の ${pending} 件が失われます`
    : // Not said while the server is storing the edits as usual: the line would come and go with each edit.
      pending > 0 && device === 'saved' && (saving === 'error' || link !== 'online')
      ? '本端末に保存済み'
      : null;
  return (
    <span className={`save-state ${saving}`} title={tip}>
      <span>
        {text}
        {note && <small>{note}</small>}
      </span>
      {saving === 'error' && <button onClick={() => void saveNow()}>もう一度</button>}
    </span>
  );
}

export function TopBar() {
  const doc = useStore((s) => s.doc);
  const docks = useStore((s) => s.docks);
  // A shared board takes back this page's own edits (see CollabState), not earlier states of the board.
  const canUndo = useStore((s) => (s.collab ? s.collab.undo : s.past.length > 0));
  const canRedo = useStore((s) => (s.collab ? s.collab.redo : s.future.length > 0));
  const saving = useStore((s) => s.saving);
  const collab = useStore((s) => s.collab);
  const takes = useTakes();
  const saveError = useStore((s) => s.saveError);
  const mode = useStore((s) => s.mode);
  const viewing = useStore((s) => !!s.viewing);
  const kind = useStore((s) => kindOf(s.doc));
  const comments = useStore((s) => openComments(s.doc).length);
  const st = useStore.getState;


  return (
    <header className="topbar">
      <b className="logo">keito</b>
      <span className="sep" />
      {/* The project on screen (its boards are the tabs below), and the others to jump to. */}
      <ProjectMenu />
      {/* Boards and files: made, copied, opened, deleted. */}
      <button className="ghost" onClick={() => openBoards(true)} data-tip="新しいボードを作る（種類を選ぶ）">
        {ICON.plus}
        新しいボード
      </button>
      <button className="ghost" data-tip="このボードをまるごと複製して、コピーを開く（図形の複製は ⌘D）" onClick={async () => st().newBoard({ ...(await inlineImages(doc)), id: randomId(), meta: { ...doc.meta, title: `${doc.meta.title} のコピー` } })}>
        {ICON.duplicate}
        ボードを複製
      </button>
      <button className="ghost" onClick={openFile} data-tip="ファイルを開いて新しいボードにする（.keito.json / .yaml）">
        {ICON.folder}
        ファイルを開く
      </button>
      <button
        className="ghost danger-hover"
        disabled={!takes('removing')}
        data-tip="このボードを削除（ボード一覧から戻せます。図形の削除は Delete）"
        onClick={() => {
          const where = collab ? '共有案件から削除しますか？\n参加している全員の画面から消えます（ボード一覧から戻せます）' : '削除しますか？\n（ボード一覧の「最近削除したボード」から戻せます）';
          void ask(`「${doc.meta.title}」を${where}`).then((yes) => yes && st().deleteBoard(doc.id));
        }}
      >
        {ICON.trash}
        ボードを削除
      </button>
      <span className="sep" />
      <button disabled={!canUndo} onClick={() => st().undo()} data-tip="元に戻す（⌘Z）" aria-label="元に戻す" className="ghost icon">{ICON.undo}</button>
      <button disabled={!canRedo} onClick={() => st().redo()} data-tip="やり直す（⇧⌘Z）" aria-label="やり直す" className="ghost icon">{ICON.redo}</button>
      <button className="ghost" disabled={viewing || !takes('tidy')} onClick={() => st().setDoc(tidy(st().doc))} data-tip="整頓: 機材の高さをそろえて線をまっすぐにし、折れ位置を並べ直す（⌘Z で戻せます）">
        {ICON.tidy}
        整頓
      </button>
      <span className="sep" />
      {collab ? (
        <SharedSaveState collab={collab} saving={saving} saveError={saveError} project={doc.meta.project} />
      ) : saving === 'gone' ? (
        // Deleted elsewhere (another tab, the command line) while it was open here.
        <span className="save-state conflict">
          ほかの場所で削除されました
          <button data-tip="この画面の内容でボードを作り直します（削除したものはボード一覧の「最近削除したボード」に残ります）" onClick={() => st().resolveConflict('overwrite')}>
            この画面で作り直す
          </button>
        </span>
      ) : saving === 'conflict' ? (
        // The board was written elsewhere (the command line …) while this page had changes of its own.
        <span className="save-state conflict">
          ほかの場所で更新されました
          <button data-tip="ファイルの内容を読み込みます（この画面の変更は ⌘Z で戻せます）" onClick={() => st().resolveConflict('reload')}>
            読み込む
          </button>
          <button data-tip="この画面の内容でファイルを上書きします" onClick={() => st().resolveConflict('overwrite')}>
            この画面で上書き
          </button>
        </span>
      ) : (
        <span className={`save-state ${saving}`} title={saving === 'error' ? `理由: ${saveError ?? '不明'}\n少しずつ間をあけて自動でやり直しています。` : shortcuts(mode === 'server' ? 'boards フォルダに自動保存（⌘S で今すぐ保存）' : 'このブラウザ内に自動保存（⌘S で今すぐ保存）')}>
          {saving === 'error' ? '保存できていません' : saving === 'saving' ? '保存中…' : mode === 'server' ? 'フォルダに保存済み' : 'ブラウザに保存済み'}
          {saving === 'error' && <button onClick={() => void saveNow()}>もう一度</button>}
        </span>
      )}
      <div className="topbar-end">
        <UpdateButton />
        {/* Panels that open beside the drawing, then the one thing the board is made for: export. */}
        {kind.lists.length > 0 && (
          <button className={`ghost${docks.lists ? ' on' : ''}`} onClick={() => st().setDock('lists')}>
            {ICON.table}
            {kind.listsLabel}
          </button>
        )}
        <button className={`ghost${docks.comments ? ' on' : ''}`} onClick={() => st().setDock('comments')} data-tip="付箋（コメント）の一覧">
          {ICON.comment}
          コメント{comments > 0 && <b className="count">{comments}</b>}
        </button>
        <button className="primary export-btn" onClick={() => st().setPanel('export')}>
          {ICON.download}
          エクスポート
        </button>
      </div>
    </header>
  );
}
