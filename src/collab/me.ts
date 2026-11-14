import { getSetting, setSetting } from '../platform/io';
import { COLORS, NAME_MAX, isColor } from './presence';

/** Who this device's user shows themselves as in shared projects (see Presence). */
export interface Me {
  name: string;
  color: string;
}

const NAME = 'presence:name';
const COLOR = 'presence:color';

/** Who this device's user shows themselves as: what they chose, else a name and a colour picked once and kept on this device. */
export function myself(): Me {
  let name = getSetting(NAME);
  let color = getSetting(COLOR);
  if (!name) setSetting(NAME, (name = `参加者 ${10 + Math.floor(Math.random() * 90)}`));
  if (!isColor(color)) setSetting(COLOR, (color = COLORS[Math.floor(Math.random() * COLORS.length)]));
  return { name, color };
}

/**
 * Show this device's user as `me` in every shared project opened on this device from now on, and say
 * who they are then: a blank name, or a colour not offered, keeps the one before.
 */
export function keepMe(me: Me): Me {
  const name = me.name.trim().slice(0, NAME_MAX);
  if (name) setSetting(NAME, name);
  if (isColor(me.color)) setSetting(COLOR, me.color);
  return myself();
}
