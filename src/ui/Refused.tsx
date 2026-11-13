import { refusalText } from '../collab/refusals';
import { useStore } from '../model/store';
import { ask } from '../platform/io';

const WARN = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 3.5l7.5 13h-15z" />
    <path d="M10 8.5v3.5M10 14.5v.01" />
  </svg>
);

/**
 * Shown across the top of a shared project's board while its server turns away edits of this page
 * (see CollabState.recover): why, whether this device keeps them, and the two ways out, taking them
 * out as boards of this machine or letting them go to open the project anew (a board of this
 * machine, when the server turns this page away again).
 */
export function RefusedBanner() {
  const recover = useStore((s) => s.collab?.recover);
  const refusal = useStore((s) => s.collab?.refusal);
  const pending = useStore((s) => s.collab?.pending);
  const kept = useStore((s) => s.collab?.device === 'saved');
  if (!recover || !refusal) return null;
  return (
    <div className="rev-banner refused" role="region" aria-label="共同編集先に送れない変更">
      <span className="why" role="alert">
        {WARN}
        <span>
          <b>{refusalText(refusal)}</b>。未送信の変更 {pending} 件は送れません{kept ? 'が、この端末に残っています' : ''}。
        </span>
      </span>
      <span className="actions">
        <button onClick={() => void ask(`未送信の変更 ${pending} 件を捨てて、共同編集先から開き直しますか？\n開けないときは、この端末のボードに戻ります。`).then((yes) => (yes ? recover.rejoin() : undefined))}>
          変更を捨てる
        </button>
        <button className="primary" onClick={() => void recover.copy()}>
          手元のボードにコピー
        </button>
      </span>
    </div>
  );
}
