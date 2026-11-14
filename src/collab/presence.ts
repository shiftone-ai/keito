import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import type { Pt, Rect } from '../model/types';

/**
 * What a page showing a shared project tells the others in it of itself, through Yjs awareness: never
 * part of the project, so neither stored, nor in its history or exports, and gone once the page
 * leaves the project or loses its connection. The name and colour are what the page says it is:
 * nothing checks them, and nothing is let in or refused by them (the server goes by the invite, see
 * server/collab/access.ts). Nor does it carry the invite.
 */
export interface Presence {
  name: string;
  color: string;
  /** The board on screen; '' for none (a project with no board). */
  board: string;
  /** Where the pointer is on that board; null while it is off it. */
  pointer: Pt | null;
  /** What is selected there. */
  selection: string[];
  /** What is being changed there and not yet written to the project (an operation under way). */
  editing: string[];
  /** Where the nodes an operation under way moves or resizes are, as the page doing it shows them. */
  moving: Moving[];
}

interface Moving extends Rect {
  id: string;
}

/** Another page in the project, as it shows itself: `id` is its client's, one per page for as long as it is open. */
export interface Peer extends Presence {
  id: number;
}

/** The colours a page may show itself in: each holds white text, as on a name tag, at 4.5:1 or more. */
export const COLORS = ['#c2410c', '#15803d', '#7e22ce', '#be185d', '#0e7490', '#a16207'] as const;
export type Color = (typeof COLORS)[number];
export const isColor = (v: string): v is Color => (COLORS as readonly string[]).includes(v);

/** The longest name shown, and the most ids or places one page is shown with; a page sending more is not shown. */
export const NAME_MAX = 40;
const IDS_MAX = 2_000;
/** Presence is sent at most this often: a pointer or a drag moves many times as often. */
const SEND_MS = 50;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): v is Pt => !!v && typeof v === 'object' && isNumber((v as Pt).x) && isNumber((v as Pt).y);
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= IDS_MAX && v.every((id) => typeof id === 'string');
const isMoving = (v: unknown): v is Moving => isPoint(v) && typeof (v as Moving).id === 'string' && isNumber((v as Moving).w) && isNumber((v as Moving).h);

/**
 * A page's presence as another page sent it, or null for anything else: sent by any client the server
 * let in, it is checked before it is shown. Only what Presence holds is kept.
 */
function readPresence(state: unknown): Presence | null {
  if (!state || typeof state !== 'object') return null;
  const { name, color, board, pointer, selection, editing, moving } = state as Record<string, unknown>;
  if (typeof name !== 'string' || name.length > NAME_MAX || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color) || typeof board !== 'string') return null;
  if (!(pointer === null || isPoint(pointer)) || !isIds(selection) || !isIds(editing)) return null;
  if (!Array.isArray(moving) || moving.length > IDS_MAX || !moving.every(isMoving)) return null;
  return {
    name,
    color,
    board,
    pointer: pointer && { x: pointer.x, y: pointer.y },
    selection,
    editing,
    moving: (moving as Moving[]).map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
  };
}

/**
 * The presence of a shared project's page: what it tells the others (`share`, sent at most every
 * SEND_MS) and what it hears of them (`peers`). A page is shown once it has shared what it shows.
 * Each connection is `attach`ed as it is made: what was shared is told on it each time it is let in,
 * and the others heard on it are let go of as it closes.
 */
export function projectPresence() {
  let provider: HocuspocusProvider | null = null;
  let awareness: Awareness | null = null;
  let mine: Presence | null = null;
  let next: Partial<Presence> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent = 0;
  const listeners = new Set<() => void>();
  const changed = (): void => listeners.forEach((hear) => hear());
  /** Heard of a change to the others: this page's own is no news to it. */
  const othersChanged = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    if ([...added, ...updated, ...removed].some((id) => id !== awareness?.clientID)) changed();
  };

  function send(): void {
    timer = undefined;
    sent = Date.now();
    mine = { ...(mine ?? { name: '', color: COLORS[0], board: '', pointer: null, selection: [], editing: [], moving: [] }), ...next };
    next = {};
    awareness?.setLocalState(mine);
  }

  /**
   * On a connection just let in: hear the others anew, and tell what was shared again, as new. Awareness
   * passes over a state heard before, and the pages gone with the last connection (theirs, or this
   * page's) are told again as they were before it.
   */
  function announce(): void {
    if (!awareness) return;
    for (const id of awareness.meta.keys()) if (id !== awareness.clientID && !awareness.states.has(id)) awareness.meta.delete(id);
    if (mine) awareness.setLocalState({ ...mine });
  }

  function detach(): void {
    provider?.off('authenticated', announce);
    awareness?.off('change', othersChanged);
    awareness?.off('destroy', detach);
    provider = awareness = null;
    changed();
  }

  return {
    attach(to: HocuspocusProvider): void {
      detach();
      if (!to.awareness) return;
      provider = to;
      awareness = to.awareness;
      to.on('authenticated', announce);
      // Left as it starts until first shared: an empty state, which no page shows.
      if (mine) awareness.setLocalState(mine);
      awareness.on('change', othersChanged);
      awareness.on('destroy', detach);
    },
    /** Tell the others this of this page, along with what was told before. */
    share(patch: Partial<Presence>): void {
      Object.assign(next, patch);
      timer ??= setTimeout(send, Math.max(0, sent + SEND_MS - Date.now()));
    },
    /** The other pages in the project, as last heard; none while not connected. */
    peers(): Peer[] {
      if (!awareness) return [];
      const peers: Peer[] = [];
      for (const [id, state] of awareness.getStates()) {
        const presence = id === awareness.clientID ? null : readPresence(state);
        if (presence) peers.push({ id, ...presence });
      }
      return peers.sort((p, q) => p.name.localeCompare(q.name) || p.id - q.id);
    },
    /** Hear of every change to the others' presence. */
    listen(hear: () => void): () => void {
      listeners.add(hear);
      return () => void listeners.delete(hear);
    },
    /** Stop: nothing more is told, and nothing more heard. */
    close(): void {
      clearTimeout(timer);
      listeners.clear();
      detach();
    },
  };
}

/** What a shared project offers of its presence (see SharedProject.presence). */
export type SharedPresence = Pick<ReturnType<typeof projectPresence>, 'share' | 'peers' | 'listen'>;
