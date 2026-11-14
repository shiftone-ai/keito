import { useState } from 'react';
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
  const device = useStore((s) => s.collab?.device);
  const [busy, setBusy] = useState(false);
  if (!recover || !refusal) return null;
  // Not said while the copy is being written: the write says which, a moment later.
  const fate = device === 'saved' ? 'が、この端末に残っています。' : device === 'saving' ? '。' : '。閉じると失われます。';
  // Not taken again while one is under way: a second click would write the boards twice.
  const settle = (how: () => Promise<unknown>) => {
    setBusy(true);
    void how().finally(() => setBusy(false));
  };
  return (
    <div className="rev-banner refused" role="region" aria-label="共同編集先に送れない変更">
      <span className="why" role="alert">
        {WARN}
        <span>
          <b>{refusalText(refusal)}</b>。未送信の変更 {pending} 件は送れません{fate}
        </span>
      </span>
      <span className="actions">
        <button disabled={busy} onClick={() => settle(() => ask(`未送信の変更 ${pending} 件を捨てて、共同編集先から開き直しますか？\n開けないときは、この端末のボードに戻ります。`).then((yes) => (yes ? recover.rejoin() : undefined)))}>
          変更を捨てる
        </button>
        <button className="primary" disabled={busy} onClick={() => settle(recover.copy)}>
          手元のボードにコピー
        </button>
      </span>
    </div>
  );
}
