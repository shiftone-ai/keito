import * as Y from 'yjs';
import { boardList, boardNodes } from './boards';
import { sharedName } from './pictureRef';

/** The pictures used on the project's live boards, whether they are on screen or not. */
export function boardPictureNames(ydoc: Y.Doc): Set<string> {
  const names = new Set<string>();
  for (const board of boardList(ydoc)) {
    boardNodes(ydoc, board.id)?.forEach((node) => {
      if (!(node instanceof Y.Map) || node.get('type') !== 'image') return;
      const src = node.get('src');
      const name = typeof src === 'string' && sharedName(src);
      if (name) names.add(name);
    });
  }
  return names;
}
