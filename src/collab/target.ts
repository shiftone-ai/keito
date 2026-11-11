import { sameBoard, stillIn } from '../model/history';
import { fitLegends } from '../model/legend';
import { shareIds } from '../model/ids';
import type { State } from '../model/store';
import type { Target } from '../model/target';
import type { Doc } from '../model/types';
import { ask } from '../platform/io';
import type { SharedProject } from './client';
import { type NodeEdit, editBetween, isNoEdit, mergeEdits, noEdit, withEdit } from './edits';
import { showSharedAddress } from './join';
import { NOT_TAKEN, sharedTakes } from './scope';

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
  /** A board has been put on screen: its address shown, and the board fitted to the window. */
  opened(): void;
}

/**
 * The target of a shared project's board (see openCollab). Its edits put nodes on the board, change
 * them and take them off (see edits.ts for what it takes); each is shown at once and written to the
 * project as one edit when its operation ends, and undo takes back this page's own edits only. The
 * collaboration server stores them, and `saving` says whether it has. It holds nothing of this
 * machine's store: the board can neither be written there nor take part in what is kept there
 * (history, other boards, pictures).
 */
export function sharedTarget(projectId: string, project: SharedProject, host: Host): Target {
  /** The board of the project on screen (see open). */
  let board = '';
  /** The board as the project has it, as last read: what the draft is shown on top of. */
  let base: Doc | null = null;
  /** The edit of the operation under way: shown here, written to the project when it ends. */
  let draft: NodeEdit = noEdit();
  const stop = project.listen(refresh);

  /**
   * Saving fails when the server cannot store the edits, or when edits it has not stored cannot be
   * kept on this device either (they are then in this page alone).
   */
  function status(): Pick<State, 'collab' | 'saving' | 'saveError'> {
    const s = project.status();
    const unkept = s.pending > 0 && s.device === 'failed';
    return {
      collab: { ...s, ...project.steps(board), unkept, project: projectId, boards: project.boards(), takes: sharedTakes },
      saving: s.failure || unkept ? 'error' : s.pending ? 'saving' : 'saved',
      saveError: unkept ? s.deviceFailure : s.failure,
    };
  }

  /** Whether nothing would be lost if the page closed now: every edit stored by the server, or kept on this device. */
  function safe(): boolean {
    const s = project.status();
    return !s.pending || s.device === 'saved';
  }

  /** The board as shown: as the project has it, with the edit under way here on top, and each legend as tall as its rows. */
  function view(): Doc {
    return shareIds(fitLegends(withEdit(base!, draft)));
  }

  /**
   * Put the board on screen as the project has it now, with the edit under way here on top. What
   * others took off the board leaves the selection.
   */
  function refresh(): void {
    const s = host.get();
    const fresh = project.board(board);
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
      takes: sharedTakes,
      edit(next, record) {
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
        const { pending } = project.status();
        if (!pending) return true;
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
    boards: {
      open(next) {
        if (next === board) return true;
        const doc = project.board(next);
        if (!doc) return false;
        host.commitOperation();
        board = next;
        base = doc;
        host.set({ doc: view(), viewing: null, past: [], future: [], selection: [], editing: null, others: [], placing: null, tool: 'select', ...status() });
        host.opened();
        return true;
      },
      remove(id) {
        if (!project.board(id)) return false;
        host.refuse();
        return true;
      },
      address: () => showSharedAddress(projectId),
    },
    local: null,
    refusal: NOT_TAKEN,
    close() {
      stop();
      project.close();
    },
  };
}

/**
 * `next`, with the nodes that did not change kept as the objects `prev` has: read anew from the
 * project, every node is a new object, and the canvas redraws what it is handed anew.
 */
function reuse(prev: Doc | null, next: Doc): Doc {
  if (!prev) return next;
  const was = new Map(prev.nodes.map((n) => [n.id, n]));
  const nodes = next.nodes.map((n) => {
    const old = was.get(n.id);
    return old && JSON.stringify(old) === JSON.stringify(n) ? old : n;
  });
  return { ...next, nodes };
}
