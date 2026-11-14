import { VIEW_ONLY, lookingOnly } from '../collab/role';
import { NOT_SHARED_YET } from '../collab/scope';
import { align, useStore, useTakes } from '../model/store';
import { Section, Head } from './inspector/fields';
import { MetaPanel } from './inspector/MetaPanel';
import { NodePanel } from './inspector/NodePanel';
import { EdgePanel } from './inspector/EdgePanel';

export function Inspector() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const looking = useStore(lookingOnly);
  const collab = useStore((s) => !!s.collab);
  const viewer = useStore((s) => s.collab?.role === 'viewer');
  // A shared project with no board has nothing to set: what is on screen is no board.
  const noBoard = useStore((s) => !!s.collab && !s.collab.boards.length);
  const takes = useTakes();
  const remove = () => useStore.getState().removeIds(selection);
  const lines = doc.edges.filter((e) => selection.includes(e.id)).length;
  // Not just 「削除」: beside 「すべてのボードから削除」 (see Shared.tsx) it would read as deleting the shared device too.
  const placed = collab && doc.nodes.some((n) => n.type === 'device' && !!n.shared && selection.includes(n.id));
  if (noBoard) return <aside className="inspector" />;
  let body;
  if (selection.length === 0) body = <MetaPanel />;
  else if (selection.length === 1) {
    const node = doc.nodes.find((n) => n.id === selection[0]);
    const edge = doc.edges.find((e) => e.id === selection[0]);
    body = node ? <NodePanel key={node.id} n={node} /> : edge ? <EdgePanel key={edge.id} e={edge} /> : null;
  } else {
    body = (
      <>
        <Head title={`${selection.length} 個を選択中`} />
        {lines > 0 && <p className="hint">{lines === selection.length ? `線 ${lines} 本` : `うち線 ${lines} 本`}。Delete キーか下の「削除」で消せます。</p>}
        {selection.length - lines >= 2 && (
          <Section title="整列">
            <div className="grid2">
              <button onClick={() => align('left')}>左揃え</button>
              <button onClick={() => align('top')}>上揃え</button>
              <button onClick={() => align('hcenter')}>左右中央</button>
              <button onClick={() => align('vcenter')}>上下中央</button>
              <button onClick={() => align('hspace')}>横に等間隔</button>
              <button onClick={() => align('vspace')}>縦に等間隔</button>
            </div>
          </Section>
        )}
      </>
    );
  }
  // An old state from the history, or a viewer's board, on screen, is for looking at: what is selected there is shown, not edited.
  if (looking && selection.length > 0)
    return (
      <aside className="inspector">
        <p className="hint">{viewer ? VIEW_ONLY : '履歴の版を表示中は編集できません。編集するには、上の帯で「この時点に戻す」か「現在の図に戻る」を選んでください。'}</p>
        <fieldset className="plain" disabled>
          {body}
        </fieldset>
      </aside>
    );
  return (
    <aside className="inspector">
      {collab && <p className="hint">{viewer ? VIEW_ONLY : `共有中の案件「${doc.meta.project}」のボードです。試験中のため、${NOT_SHARED_YET}は、まだ共有できません。`}</p>}
      {!takes('settings') && !selection.length ? (
        <fieldset className="plain" disabled>
          {body}
        </fieldset>
      ) : (
        body
      )}
      {selection.length > 0 && (
        <button className="danger wide" onClick={remove}>
          {placed ? 'このボードから削除' : '削除'}
        </button>
      )}
    </aside>
  );
}
