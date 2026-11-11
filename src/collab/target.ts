import { sameBoard, stillIn } from '../model/history';
import { fitLegends } from '../model/legend';
import { shareIds } from '../model/ids';
import type { State, View } from '../model/store';
import type { Target } from '../model/target';
import type { Doc } from '../model/types';
import { ask } from '../platform/io';
import type { LinkRefusal, SharedProject } from './client';
import { type BoardEdit, editBetween, isNoEdit, mergeEdits, noEdit, withEdit } from './edits';
import { type EditKind, NOT_TAKEN, emptyTakes, sharedTakes } from './scope';
import { sharedTabs } from './tabs';
import { validDrawing } from './valid';

/** Said when the shared project on screen, having no board, is asked for an edit. */
const NO_BOARD = 'この共有案件にはボードがありません';

/** What the target of a shared board needs of the edit session it is the target of. */
export interface Host {
  get(): State;
  set(change: Partial<State>): void;
  say(text: string): void;
  /** Tell the user the board does not take what was asked of it (its `refusal`). */
  refuse(): void;
  /** Start an operation on the board as it is (the session's checkpoint). */
  checkpoint(): void;
  /** End the operation under way. */
  commitOperation(): void;
  /** Whether an operation is under way. */
  operating(): boolean;
  /** A board has been put on screen: its address shown, and the board on `view`, or fitted to the window (undefined). */
  opened(view: View | undefined): void;
  /**
   * The server turned this page away while it had the project open (the project deleted …): the
   * session leaves it, telling the user why.
   */
  refused(refusal: LinkRefusal): void;
}

/** The target of a shared project's board, and what puts the project on screen in the first place. */
export interface SharedTarget extends Target {
  /** Put the project on screen: on the board last shown on this machine, else the first tab, else none. */
  start(): void;
}

/**
 * The target of a shared project's board (see openCollab). Its edits put nodes on the board, change
 * them and take them off (see edits.ts for what it takes); each is shown at once and written to the
 * project as one edit when its operation ends, and undo takes back this page's own edits only. The
 * collaboration server stores them, and `saving` says whether it has. It holds nothing of this
 * machine's store: the board can neither be written there nor take part in what is kept there
 * (history, other boards, pictures). Which of the project's boards is on screen, and managing them,
 * is tabs.ts's.
 */
export function sharedTarget(projectId: string, project: SharedProject, host: Host): SharedTarget {
  /** The board of the project on screen (see put); '' for none, the project having no board. */
  let board = '';
  /** The board as the project has it, as last read: what the draft is shown on top of. */
  let base: Doc = noBoard();
  /** The edit of the operation under way: shown here, written to the project when it ends. */
  let draft: BoardEdit = noEdit();
  /** Undoes the ids of the board on screen being made unique wherever they are made (see shareIds). */
  let unshare = (): void => {};
  /** Set while a board is left (see put): what is heard meanwhile is shown with the board put next. */
  let switching = false;
  /** Set once the server has turned this page away: the session is leaving the project. */
  let leaving = false;
  const takes = (what: EditKind): boolean => (board ? sharedTakes(what) : emptyTakes(what));
  const tabs = sharedTabs(projectId, project, {
    shown: () => board,
    put,
    view: () => host.get().view,
    opened: host.opened,
    say: host.say,
  });
  const stop = project.listen(refresh);

  /** What is on screen while the project has no board: nothing, under the project's name. */
  function noBoard(): Doc {
    return { version: 1, id: projectId, meta: { title: '', project: project.title() }, nodes: [], edges: [] };
  }

  /**
   * Saving fails when the server cannot store the edits, or when edits it has not stored cannot be
   * kept on this device either (they are then in this page alone).
   */
  function status(): Pick<State, 'collab' | 'saving' | 'saveError'> {
    const s = project.status();
    const unkept = s.pending > 0 && s.device === 'failed';
    return {
      collab: { ...s, ...project.steps(board), unkept, project: projectId, boards: project.boards(), deleted: project.deletedBoards(), takes, manage: tabs.manage },
      saving: s.failure || unkept ? 'error' : s.pending ? 'saving' : 'saved',
      saveError: unkept ? s.deviceFailure : s.failure,
    };
  }

  /** Whether nothing would be lost if the page closed now: every edit stored by the server, or kept on this device. */
  function safe(): boolean {
    const s = project.status();
    return !s.pending || s.device === 'saved';
  }

  /**
   * The board as shown: as the project has it, with the edit under way here on top (without the lines
   * whose ends others took off meanwhile), and each legend as tall as its rows.
   */
  function view(): Doc {
    return fitLegends(validDrawing(withEdit(base, draft)));
  }

  /** Put a board on screen as the project has it now, or the project with none (''). */
  function put(next: string): void {
    switching = true;
    try {
      // Called off, not written: kept on a board deleted meanwhile, it would come back with a restore.
      if (board && !project.board(board)) draft = noEdit();
      host.commitOperation();
    } finally {
      switching = false;
    }
    board = next;
    base = (next && project.board(next)) || noBoard();
    draft = noEdit();
    unshare();
    unshare = next ? shareIds(next) : () => {};
    host.set({ doc: view(), viewing: null, past: [], future: [], selection: [], editing: null, others: [], placing: null, tool: 'select', ...status() });
  }

  /**
   * Put the board on screen as the project has it now, with the edit under way here on top. What
   * others took off the board leaves the selection; the board itself taken off, another is shown.
   */
  function refresh(): void {
    if (switching || leaving) return;
    const { link, refusal } = project.status();
    if (link === 'refused') {
      leaving = true;
      return host.refused(refusal ?? 'no-access');
    }
    if (tabs.follow()) return;
    const s = host.get();
    const fresh = board ? project.board(board) : noBoard();
    if (fresh && !sameBoard(fresh, base)) base = reuse(base, fresh);
    const shown = view();
    const doc = sameBoard(shown, s.doc) ? s.doc : shown;
    const selection = stillIn(doc, s.selection);
    host.set({ doc, ...(selection.length === s.selection.length ? {} : { selection }), ...status() });
  }

  /** Write the edit of the operation just ended to the project, as one edit (sent to be stored). */
  function write(): void {
    const edit = draft;
    draft = noEdit();
    if (!isNoEdit(edit)) project.edit(board, edit);
    refresh();
  }

  /** Undo or redo this page's last edit of the board: what others did stays. */
  function step(way: 'undo' | 'redo'): void {
    project[way](board);
    refresh();
  }

  return {
    edits: {
      takes,
      edit(next, record) {
        if (!board) return host.refuse();
        const edit = editBetween(host.get().doc, next);
        if (!edit) return host.refuse();
        if (isNoEdit(edit)) return;
        // Not made an operation of its own: that would be a step of its own to undo, where a board of
        // this machine adds it to the last (the presses of a key held down are one move).
        if (!record && !host.operating()) {
          project.edit(board, edit, true);
          return refresh();
        }
        if (record) host.checkpoint();
        draft = mergeEdits(draft, edit);
        host.set({ doc: view() });
        if (record) host.commitOperation();
      },
      // Not undone by putting back a whole earlier board: that would undo others' edits too.
      begin: () => {},
      end: write,
      drop() {
        draft = noEdit();
        refresh();
        host.set({ selection: [], editing: null });
        return true;
      },
      undo: () => step('undo'),
      redo: () => step('redo'),
      // Nothing of it is kept here: a return to it goes through its project.
      keepSteps: () => {},
    },
    saving: {
      async flush() {
        host.commitOperation();
        return safe();
      },
      async saveNow() {
        host.commitOperation();
        project.retry();
        if (!project.status().pending) host.say('共同編集先に保存済みです（変更は自動で保存されます）');
      },
      async leave() {
        const { pending, link } = project.status();
        // Turned away, the project stores nothing more, and its copy here is not sent (see kept.ts): asking would offer no way to keep it.
        if (!pending || link === 'refused') return true;
        if (!safe()) return ask(`共同編集先にまだ保存されていない変更が ${pending} 件あります。\n切り替えると、この変更は失われます。切り替えますか？`);
        host.say(`未送信の変更 ${pending} 件は、この共有案件を次に開いたときに送ります`);
        return true;
      },
      closing: () => !safe(),
      // Nothing can go out as the page goes: `closing` has the browser ask about what is not stored yet.
      exit: () => {},
      // What fails in this machine's store says nothing of what the server has stored.
      failed: () => {},
    },
    boards: tabs.boards,
    local: null,
    get refusal() {
      return board ? NOT_TAKEN : NO_BOARD;
    },
    start: tabs.start,
    close() {
      unshare();
      stop();
      project.close();
    },
  };
}

/**
 * `next`, with the nodes and lines that did not change kept as the objects `prev` has: read anew from
 * the project, every one is a new object, and the canvas redraws what it is handed anew.
 */
function reuse(prev: Doc | null, next: Doc): Doc {
  if (!prev) return next;
  return { ...next, nodes: reused(prev.nodes, next.nodes), edges: reused(prev.edges, next.edges) };
}

function reused<T extends { id: string }>(prev: readonly T[], next: T[]): T[] {
  const was = new Map(prev.map((x) => [x.id, x]));
  return next.map((x) => {
    const old = was.get(x.id);
    return old && JSON.stringify(old) === JSON.stringify(x) ? old : x;
  });
}
