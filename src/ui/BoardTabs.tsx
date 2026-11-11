import { KINDS, tabOrder } from '../model/kinds';
import { useStore } from '../model/store';
import type { Doc } from '../model/types';
import type { BoardInfo } from '../platform/storage';
import { openBoards } from './Boards';

/** A board of the open board's project, as its tab shows it. */
type Tab = Pick<BoardInfo, 'id' | 'title' | 'kind'>;

/**
 * The open board's project as tabs (the open board as it is now, its title or kind just edited
 * included). A shared project's tabs are its own boards (`shared`, see CollabState), the one on
 * screen among them (or none, the project having no board): a board of this machine is never one
 * of them, whatever its project is named.
 */
function projectTabs(doc: Doc, boards: BoardInfo[], shared?: readonly Tab[]): Tab[] {
  if (shared) return tabOrder([...shared]);
  const project = doc.meta.project?.trim();
  const here: Tab = { id: doc.id, title: doc.meta.title, kind: doc.kind };
  const fellows = project ? boards.filter((b) => (b.project ?? '').trim() === project) : [];
  return tabOrder([here, ...fellows.filter((b) => b.id !== doc.id)]);
}

/** projectTabs for the store's open board, re-rendered as it or the boards change. */
export function useProjectTabs(): Tab[] {
  const doc = useStore((s) => s.doc);
  const boards = useStore((s) => s.boards);
  const shared = useStore((s) => s.collab?.boards);
  return projectTabs(doc, boards, shared);
}

/**
 * The id of the tab `step` tabs away (−1: back) from the tab `from`, or from the open board's tab when
 * `from` is not one of them; past either end, it wraps round. Undefined when the open board's project
 * has only one tab.
 */
export function boardBeside(doc: Doc, boards: BoardInfo[], step: 1 | -1, from?: string, shared?: readonly Tab[]): string | undefined {
  const tabs = projectTabs(doc, boards, shared);
  if (tabs.length < 2) return undefined;
  const at = tabs.findIndex((b) => b.id === from);
  const here = at >= 0 ? at : tabs.findIndex((b) => b.id === doc.id);
  return tabs[(here + step + tabs.length) % tabs.length].id;
}

/** The id of the tab at `place` from the left, counted from 0 (−1: the last), or undefined past the last tab. */
export function boardAt(doc: Doc, boards: BoardInfo[], place: number, shared?: readonly Tab[]): string | undefined {
  return projectTabs(doc, boards, shared).at(place)?.id;
}

/** The project's boards as tabs under the top bar: one click to another board of the same project. */
export function BoardTabs() {
  const st = useStore.getState;
  const current = useStore((s) => s.doc.id);
  const project = useStore((s) => s.doc.meta.project?.trim());
  const tabs = useProjectTabs();
  return (
    <nav className="board-tabs" aria-label="同じ案件のボード">
      {tabs.map((b) => {
        const kind = KINDS[b.kind ?? 'system'];
        return (
          <button key={b.id} className={`board-tab ${kind.id}${b.id === current ? ' on' : ''}`} title={`${kind.label}　${b.title}`} onClick={() => st().openBoard(b.id)}>
            <i />
            <span>{b.title || '無題のボード'}</span>
          </button>
        );
      })}
      <button className="board-tab add" data-tip={project ? `「${project}」に新しいボードを追加` : '新しいボード'} aria-label="新しいボード" onClick={() => openBoards(true)}>
        ＋
      </button>
      {!project && <span className="board-tabs-hint">ボード設定で案件名を付けると、同じ案件のボードがここにタブで並びます</span>}
    </nav>
  );
}
