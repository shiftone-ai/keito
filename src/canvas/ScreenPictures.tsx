import { type ReactNode, useMemo } from 'react';
import { useStore } from '../model/store';
import { PictureSource } from './SharedPicture';

/** The pictures of the shared project on screen and the board's zoom, for the pictures drawn on it (see SharedPicture). */
export function ScreenPictures({ children }: { children: ReactNode }) {
  const pictures = useStore((s) => s.collab?.pictures ?? null);
  const zoom = useStore((s) => s.view.k);
  const source = useMemo(() => ({ pictures, zoom }), [pictures, zoom]);
  return <PictureSource.Provider value={source}>{children}</PictureSource.Provider>;
}
