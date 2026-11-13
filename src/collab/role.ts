import type { State } from '../model/store';

/** Said when a viewer asks for an edit (the server would refuse it), and shown beside a viewer's board. */
export const VIEW_ONLY = '閲覧のみの招待では編集できません';

/**
 * Whether the board on screen is only to be looked at: an old state from the history, or a shared
 * project joined with a viewer's invite. The screen then offers no edit (hidden or disabled), as the
 * board would refuse it. Kept apart from Yjs so that the app's first load does not carry it.
 */
export const lookingOnly = (s: Pick<State, 'viewing' | 'collab'>): boolean => !!s.viewing || s.collab?.role === 'viewer';
