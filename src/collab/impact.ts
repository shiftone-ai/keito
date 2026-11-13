import { deviceName } from '../model/shared';
import type { DeviceNode, Doc } from '../model/types';

/**
 * What deleting a shared device takes off the project's boards as the drawing shows them (see
 * devices.ts): the devices placed from it, their ports and the lines to them. Kept apart from Yjs so
 * that the app's first load does not carry it.
 */
export interface Impact {
  /** The shared device's name, its first line. */
  name: string;
  boards: number;
  placements: number;
  ports: number;
  lines: number;
  /** Software running on it, left with no host. */
  software: number;
}

/** What deleting the shared device under `key` takes off `boards`, the project's live boards. */
export function impactOf(boards: readonly Doc[], key: string): Impact {
  const out: Impact = { name: '', boards: 0, placements: 0, ports: 0, lines: 0, software: 0 };
  for (const doc of boards) {
    out.software += doc.nodes.filter((n) => n.type === 'device' && n.runsOn === key).length;
    const placed = doc.nodes.filter((n): n is DeviceNode => n.type === 'device' && n.shared === key);
    if (!placed.length) continue;
    out.name ||= deviceName(placed[0]);
    out.boards++;
    out.placements += placed.length;
    out.ports += placed.reduce((sum, n) => sum + n.ports.length, 0);
    const ids = new Set(placed.map((n) => n.id));
    out.lines += doc.edges.filter((e) => ids.has(e.from.node) || ids.has(e.to.node)).length;
  }
  return out;
}

/** What the user is asked before a shared device is deleted. */
export const deleteQuestion = (i: Impact): string =>
  `「${i.name}」をすべてのボードから削除しますか？\n${i.boards} 枚のボードにある「${i.name}」${i.placements} 個と、そのポート ${i.ports} 個が消えます。` +
  (i.lines ? `つながっている線 ${i.lines} 本も消えます。` : '') +
  (i.software ? `\n「${i.name}」を動作ホストにしているソフトウェア ${i.software} 個は、動作ホストがなくなります。` : '');
