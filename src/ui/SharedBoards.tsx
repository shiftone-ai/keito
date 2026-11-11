import { useState } from 'react';
import type { SharedBoardInfo } from '../collab/boards';
import { SHARED_KINDS } from '../collab/scope';
import { type BoardKind, KINDS, tabOrder } from '../model/kinds';
import { type CollabState, useStore } from '../model/store';
import { composing } from './keys';

const kindOf = (b: SharedBoardInfo) => KINDS[b.kind ?? 'system'] ?? KINDS.system;

/** A name typed in place: Enter or clicking elsewhere keeps it, Escape lets it go. */
function NameField({ value, label, done }: { value: string; label: string; done: (name: string | null) => void }) {
  const [name, setName] = useState(value);
  const keep = () => done(name.trim() && name.trim() !== value ? name : null);
  return (
    <input
      autoFocus
      aria-label={label}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (composing(e)) return;
        if (e.key === 'Enter') keep();
        else if (e.key === 'Escape') {
          e.stopPropagation();
          done(null);
        }
      }}
      onBlur={keep}
    />
  );
}

/** A deleted board, one click from coming back (and opening). */
function DeletedCard({ board, collab, done }: { board: SharedBoardInfo; collab: CollabState; done?: () => void }) {
  return (
    <div className="board-card trashed">
      <b className={`kind-badge ${board.kind ?? 'system'}`}>{kindOf(board).label}</b>
      <span className="title">{board.title}</span>
      <button
        className="mini"
        onClick={() => {
          collab.manage.restore(board.id);
          done?.();
        }}
      >
        戻す
      </button>
    </div>
  );
}

/**
 * The shared project on screen in the boards window: its boards (a click opens one), a board added
 * for everyone, a board or the project renamed, and the deleted boards brought back. What is done
 * here reaches everyone in the project.
 */
export function SharedProjectBoards({ collab, withForm, close }: { collab: CollabState; withForm: boolean; close: () => void }) {
  const st = useStore.getState;
  const current = useStore((s) => s.doc.id);
  const project = useStore((s) => s.doc.meta.project ?? '');
  const [form, setForm] = useState<{ kind: BoardKind; title: string } | null>(withForm ? { kind: SHARED_KINDS[0], title: '' } : null);
  /** The board being renamed, or '' for the project. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const add = (f: { kind: BoardKind; title: string }) => {
    collab.manage.add(f.title, f.kind);
    close();
  };

  return (
    <div className="col">
      <div className="project-head">
        {renaming === '' ? (
          <NameField
            value={project}
            label="案件名"
            done={(name) => {
              if (name !== null) collab.manage.renameProject(name);
              setRenaming(null);
            }}
          />
        ) : (
          <h3>{project}</h3>
        )}
        {renaming !== '' && (
          <button className="mini" data-tip="参加している全員の画面で案件名が変わります" onClick={() => setRenaming('')}>
            名前を変える
          </button>
        )}
        <span className="grow" />
        {!form && (
          <button className="primary" onClick={() => setForm({ kind: SHARED_KINDS[0], title: '' })}>
            ＋ 新しいボード
          </button>
        )}
      </div>
      {form && (
        <div className="new-board">
          <div className="kinds">
            {SHARED_KINDS.map((k) => (
              <button key={k} className={`kind-card${form.kind === k ? ' on' : ''}`} aria-pressed={form.kind === k} onClick={() => setForm({ ...form, kind: k })}>
                <b className={`kind-badge ${k}`}>{KINDS[k].label}</b>
                <small>{KINDS[k].hint}</small>
              </button>
            ))}
          </div>
          <div
            className="row"
            onKeyDown={(e) => {
              if (composing(e) || !(e.target instanceof HTMLInputElement)) return;
              if (e.key === 'Enter') add(form);
              else if (e.key === 'Escape') {
                e.stopPropagation();
                setForm(null);
              }
            }}
          >
            <input autoFocus placeholder={`ボードの名前（空なら「${KINDS[form.kind].label}」）`} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <button className="primary" onClick={() => add(form)}>
              追加する
            </button>
            <button onClick={() => setForm(null)}>やめる</button>
          </div>
        </div>
      )}
      <div className="board-cards">
        {tabOrder(collab.boards).map((b) => {
          const open = () => {
            st().openBoard(b.id);
            close();
          };
          return (
            // The whole card opens the board, as a card of this machine's board does; the button is there for the keyboard.
            <div key={b.id} className={`board-card shared${b.id === current ? ' on' : ''}`} onClick={renaming === b.id ? undefined : open}>
              <button
                className="open"
                onClick={(e) => {
                  e.stopPropagation();
                  open();
                }}
              >
                <b className={`kind-badge ${b.kind ?? 'system'}`}>{kindOf(b).label}</b>
                {renaming !== b.id && <span className="title">{b.title}</span>}
              </button>
              {renaming === b.id ? (
                <NameField
                  value={b.title}
                  label="ボード名"
                  done={(name) => {
                    if (name !== null) collab.manage.rename(b.id, name);
                    setRenaming(null);
                  }}
                />
              ) : (
                <span className="foot">
                  <small>{b.id === current ? '表示中' : ''}</small>
                  <button
                    className="mini"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming(b.id);
                    }}
                  >
                    名前を変える
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {collab.deleted.length > 0 && (
        <>
          <h4 className="deleted-head">削除したボード</h4>
          <div className="board-cards">
            {tabOrder(collab.deleted).map((b) => (
              <DeletedCard key={b.id} board={b} collab={collab} done={close} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** On the canvas of a shared project with no board: a board to add, or a deleted one to bring back. */
export function EmptyProject({ collab, add }: { collab: CollabState; add: () => void }) {
  return (
    <div className="empty-project">
      <button className="primary" onClick={add}>
        ＋ ボードを追加
      </button>
      {collab.deleted.length > 0 && (
        <>
          <h4 className="deleted-head">削除したボード</h4>
          <div className="board-cards">
            {tabOrder(collab.deleted).map((b) => (
              <DeletedCard key={b.id} board={b} collab={collab} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
