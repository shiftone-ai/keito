import type { State } from '../model/store';

/** Said when a viewer asks for an edit (the server would refuse it), and shown beside a viewer's board. */
export const VIEW_ONLY = '閲覧のみの招待では編集できません';

/** Said when an edit is asked of a shared project whose server turned this page's edits away, and shown beside its board. */
export const TURNED_AWAY = 'この共有案件は編集できません（上の帯で、共同編集先に送れない変更をどうするか選んでください）';

/**
 * Whether the project on screen is a shared one only looked at: joined with a viewer's invite, or
 * one whose server turned this page's edits away. Its boards are neither added, renamed nor brought
 * back from this page (see BoardManagement), and the screen offers none of it.
 */
export const projectLookingOnly = (s: Pick<State, 'collab'>): boolean => s.collab?.role === 'viewer' || s.collab?.link === 'refused';

/**
 * Whether the board on screen is only to be looked at: an old state from the history, a shared
 * project joined with a viewer's invite, or one whose server turned this page's edits away. The
 * screen then offers no edit (hidden or disabled), as the board would refuse it. Kept apart from Yjs
 * so that the app's first load does not carry it.
 */
export const lookingOnly = (s: Pick<State, 'viewing' | 'collab'>): boolean => !!s.viewing || projectLookingOnly(s);

/** Said when an edit is asked of a shared board only to be looked at (see lookingOnly), by why it is. */
export const lookingNote = (s: Pick<State, 'collab'>): string => (s.collab?.link === 'refused' ? TURNED_AWAY : VIEW_ONLY);
