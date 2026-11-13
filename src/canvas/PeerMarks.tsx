// What the others in a shared project are doing on the board on screen, drawn over it in their colours.
import type { Peer } from '../collab/presence';
import { nodeRect, pathD } from '../model/geometry';
import { useStore } from '../model/store';
import { UI_FONT, measure } from '../model/text';
import type { Doc, Pt } from '../model/types';
import { mid } from './render';

/** A name tag's type: as on screen at every zoom. */
const TAG_FONT = 11;
const TAG_PAD = 6;
const TAG_H = 18;

/** A name tag in the peer's colour, its top left at `at` (sizes as on screen, at zoom `k`); `pencil` while they edit. */
function Tag({ at, peer, k, pencil }: { at: Pt; peer: Peer; k: number; pencil?: boolean }) {
  const icon = pencil ? 12 : 0;
  const w = measure(peer.name, `600 ${TAG_FONT}px ${UI_FONT}`) + TAG_PAD * 2 + icon;
  return (
    <g transform={`translate(${at.x},${at.y}) scale(${1 / k})`}>
      <rect width={w} height={TAG_H} rx={4} fill={peer.color} />
      {pencil && <path d="M6 12.5l.6-2.6 5-5 2 2-5 5zM10.6 5.9l2 2" fill="none" stroke="#fff" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />}
      <text x={TAG_PAD + icon} y={mid(TAG_H / 2, TAG_FONT)} fontSize={TAG_FONT} fontWeight={600} fill="#fff" fontFamily={UI_FONT}>
        {peer.name}
      </text>
    </g>
  );
}

/**
 * The marks of the others on the board on screen: what each has selected or is editing, outlined in
 * their colour and named (with a pencil on what they edit), where what they drag is as it goes, and their
 * pointer with their name. Marks of what is not on the board (taken off meanwhile) are not drawn.
 */
export function PeerMarks({ doc, routes, k }: { doc: Doc; routes: Map<string, Pt[]>; k: number }) {
  const peers = useStore((s) => s.peers);
  const here = peers.filter((p) => p.board === doc.id);
  if (!here.length) return null;
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const pad = 4 / k;
  return (
    <g pointerEvents="none">
      {here.map((peer) => {
        const marked = [...new Set([...peer.selection, ...peer.editing])];
        const edited = peer.editing.map((id) => nodes.get(id)).find((n) => !!n);
        const tagged = edited ?? peer.selection.map((id) => nodes.get(id)).find((n) => !!n);
        const tagAt = tagged && nodeRect(tagged);
        return (
          <g key={peer.id} data-peer={peer.name}>
            {marked.map((id) => {
              const n = nodes.get(id);
              if (n) {
                const r = nodeRect(n);
                return <rect key={id} x={r.x - pad} y={r.y - pad} width={r.w + pad * 2} height={r.h + pad * 2} rx={4 / k} fill="none" stroke={peer.color} strokeWidth={2 / k} />;
              }
              const line = routes.get(id);
              return line ? <path key={id} d={pathD(line, 8)} fill="none" stroke={peer.color} strokeOpacity={0.4} strokeWidth={8 / k} strokeLinecap="round" strokeLinejoin="round" /> : null;
            })}
            {/* Not a rect: it would be taken for the node itself wherever the board's rects are looked through. */}
            {peer.moving.map((m) => (
              <path key={`moving-${m.id}`} className="peer-moving" d={`M${m.x} ${m.y}h${m.w}v${m.h}h${-m.w}z`} fill={peer.color} fillOpacity={0.08} stroke={peer.color} strokeWidth={1.5 / k} strokeDasharray={`${6 / k} ${4 / k}`} />
            ))}
            {tagAt && <Tag at={{ x: tagAt.x - pad, y: tagAt.y - pad - (TAG_H + 2) / k }} peer={peer} k={k} pencil={!!edited} />}
            {peer.pointer && (
              <g className="peer-pointer">
                <path transform={`translate(${peer.pointer.x},${peer.pointer.y}) scale(${1 / k})`} d="M0 0l0 15 4-3.6 2.6 6 2.6-1.1-2.6-5.9 5.4-.4z" fill={peer.color} stroke="#fff" strokeWidth={1.2} strokeLinejoin="round" />
                <Tag at={{ x: peer.pointer.x + 12 / k, y: peer.pointer.y + 16 / k }} peer={peer} k={k} />
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}
