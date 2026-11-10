import { KINDS, KIND_ORDER } from '../model/kinds';
import { useStore } from '../model/store';
import type { Doc } from '../model/types';
import type { BoardInfo } from '../platform/storage';
import { openBoards } from './Boards';

const rank = (kind: Doc['kind']): number => KIND_ORDER.indexOf(kind ?? 'system');

/** Boards of one project in the order of their tabs: by kind (system, software, sequence, free), then title. */
export function tabOrder<T extends { kind?: Doc['kind']; title: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind) || a.title.localeCompare(b.title, 'ja', { numeric: true }));
}

/** The open board's project as tabs (the open board as it is now, its title or kind just edited included). */
function projectTabs(doc: Doc, boards: BoardInfo[]): BoardInfo[] {
  const project = doc.meta.project?.trim();
  const here: BoardInfo = { id: doc.id, title: doc.meta.title, updated: Date.now(), project: doc.meta.project || undefined, kind: doc.kind };
  if (!project) return [here];
  return tabOrder([here, ...boards.filter((b) => b.id !== doc.id && (b.project ?? '').trim() === project)]);
}

/** The open board's project as tabs, as the store has it now. */
export function useProjectTabs(): BoardInfo[] {
  const doc = useStore((s) => s.doc);
  const boards = useStore((s) => s.boards);
  return projectTabs(doc, boards);
}

/**
 * The board a tab on (−1: a tab back) from `from`, a tab of the open board's project, or else from
 * the open board; round from either end. None when the open board has the only tab.
 */
export function boardBeside(doc: Doc, boards: BoardInfo[], step: 1 | -1, from?: string): string | undefined {
  const tabs = projectTabs(doc, boards);
  if (tabs.length < 2) return undefined;
  const at = tabs.findIndex((b) => b.id === from);
  const here = at >= 0 ? at : tabs.findIndex((b) => b.id === doc.id);
  return tabs[(here + step + tabs.length) % tabs.length].id;
}

/** The board the last press of ⌘⇧] or ⌘⇧[ opens, until it has opened (or the opening has ended otherwise). */
let opening: string | undefined;

/**
 * The board a press of ⌘⇧] (1) or ⌘⇧[ (−1) goes to: a tab on from the board the last press is still
 * opening, so that presses quicker than a board opens (a key held down) each go a tab further.
 */
export function nextTab(step: 1 | -1): string | undefined {
  const { doc, boards } = useStore.getState();
  return boardBeside(doc, boards, step, opening);
}

/** Opens the board a press went to. */
export function openTab(id: string): void {
  opening = id;
  void useStore.getState().openBoard(id).finally(() => {
    if (opening === id) opening = undefined;
  });
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
