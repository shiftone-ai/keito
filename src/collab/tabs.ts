import { type BoardKind, KINDS, tabOrder } from '../model/kinds';
import type { View } from '../model/store';
import type { Boards } from '../model/target';
import { getSetting, setSetting } from '../platform/io';
import type { SharedBoardInfo } from './boards';
import type { SharedProject } from './client';
import { showSharedAddress } from './join';

/**
 * Managing a shared project's boards for everyone in it (deleting one is Boards.remove). Each goes to
 * the project under an origin of its own (see client.ts): undoing the drawing never takes it back.
 */
export interface BoardManagement {
  /** Add an empty board to the project, and open it. */
  add(title: string, kind: BoardKind): void;
  rename(id: string, title: string): void;
  /** Bring a deleted board back, and open it. */
  restore(id: string): void;
  /** Rename the project: its id, and so where it is shared, stays. */
  renameProject(title: string): void;
}

/** What the tabs of a shared project need of the target of its board on screen. */
export interface TabsHost {
  /** The board on screen; '' for none (the project has no board). */
  shown(): string;
  /** Put a board on screen as the project has it now, or none (''). */
  put(board: string): void;
  /** The view of the board on screen. */
  view(): View;
  /** The board just put on screen is shown: on the view it was left with on this page, or fitted to the window (undefined). */
  opened(view: View | undefined): void;
  say(text: string): void;
}

/** Where this machine keeps the board of the project last shown (see getSetting). */
const lastShown = (project: string): string => `collab:${project}:board`;

/**
 * The tabs of a shared project as this page shows them. Which board is on screen is this page's
 * own: kept on this machine for the next visit, and each board keeps the view it was left with
 * here. A board deleted while on screen, by anyone, gives way to the tab beside it, or to the empty
 * project; a board added or restored then is opened.
 */
export function sharedTabs(projectId: string, project: SharedProject, host: TabsHost) {
  const views = new Map<string, View>();

  /** The board in tab order after `board` (gone, or going), else the one before; '' for none. */
  function beside(board: SharedBoardInfo): string {
    const tabs = tabOrder([board, ...project.boards().filter((b) => b.id !== board.id)]);
    const at = tabs.findIndex((b) => b.id === board.id);
    return (tabs[at + 1] ?? tabs[at - 1])?.id ?? '';
  }

  function show(next: string): void {
    const left = host.shown();
    if (left) views.set(left, host.view());
    host.put(next);
    if (next) setSetting(lastShown(projectId), next);
    host.opened(next ? views.get(next) : undefined);
  }

  function open(next: string): boolean {
    if (next === host.shown()) return true;
    if (!project.board(next)) return false;
    show(next);
    return true;
  }

  const boards: Boards = {
    open,
    remove(id) {
      const board = project.boards().find((b) => b.id === id);
      if (!board) return project.deletedBoards().some((b) => b.id === id);
      // Left first: deleted on screen, the board would be taken for one deleted by someone else.
      if (id === host.shown()) show(beside(board));
      project.removeBoard(id);
      return true;
    },
    address: () => showSharedAddress(projectId),
  };

  const manage: BoardManagement = {
    add(title, kind) {
      const id = project.addBoard(title.trim() || KINDS[kind].label, kind);
      if (id) open(id);
    },
    rename(id, title) {
      if (title.trim()) project.renameBoard(id, title.trim());
    },
    restore(id) {
      project.restoreBoard(id);
      open(id);
    },
    renameProject(title) {
      if (title.trim()) project.renameProject(title.trim());
    },
  };

  return {
    boards,
    manage,
    /** Put the project on screen: on the board last shown on this machine, if it is still there, else the first tab, else none. */
    start(): void {
      const last = getSetting(lastShown(projectId));
      show(last && project.board(last) ? last : (tabOrder(project.boards())[0]?.id ?? ''));
    },
    /**
     * Follow the project as it is now: off the board on screen once it is deleted, onto a board once
     * the empty project has one again. Whether another board (or none) was put on screen.
     */
    follow(): boolean {
      const shown = host.shown();
      if (!shown) {
        const first = tabOrder(project.boards())[0]?.id;
        if (first) show(first);
        return !!first;
      }
      if (project.board(shown)) return false;
      const gone = project.deletedBoards().find((b) => b.id === shown) ?? { id: shown, title: '', kind: undefined };
      const next = beside(gone);
      show(next);
      const title = project.boards().find((b) => b.id === next)?.title;
      host.say(next ? `表示中のボード「${gone.title}」が削除されたため、「${title}」を開きました` : `表示中のボード「${gone.title}」が削除されました（この共有案件には、ほかにボードがありません）`);
      return true;
    },
  };
}
