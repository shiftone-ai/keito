/**
 * Why a shared project's server turns this page away, as the user is told it. Kept apart from Yjs
 * (client.ts) so that the screen can say it without the app's first load carrying Yjs.
 */
import type { Refusal } from './protocol';

/**
 * Why the link is 'refused': a refusal of the server (see protocol.ts; `deleted` and `revoked` also
 * while connected); `unreachable`, no server answered; `read-only`, the server let this page in to
 * look only while it holds edits not sent, or turned an edit away as a viewer's; `malformed`, the
 * server could not read an edit of this page.
 */
export type LinkRefusal = Refusal | 'unreachable' | 'read-only' | 'malformed';

/** What the user is told when the project cannot be opened (or is left, or its edits not sent), by the reason it was turned away. */
const REFUSALS: Record<LinkRefusal, string> = {
  deleted: 'この共有案件は削除されています',
  revoked: 'この共有案件への招待は取り消されました',
  schema: 'この版の keito では開けない共有案件です',
  unreachable: '共同編集先に接続できません（サーバーが動いているか、参加リンクのアドレスが正しいかを確かめてください）',
  'no-access': '共有案件に接続できません（参加の権限がないか、案件がありません）',
  'read-only': '閲覧のみの招待で開いています',
  malformed: '共同編集先が、この端末の変更を読み取れませんでした',
};

/** What the user is told of a link 'refused' for this reason. */
export const refusalText = (refusal: LinkRefusal): string => REFUSALS[refusal];

/** A reason as the server (or a copy kept by an earlier version) gives it; one this version does not know is told as the general one. */
export const refusalOf = (reason: string): LinkRefusal => (Object.hasOwn(REFUSALS, reason) ? (reason as LinkRefusal) : 'no-access');
