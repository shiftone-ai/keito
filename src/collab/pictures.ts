/**
 * The pictures of a shared project on this page: those put on a board here, kept on this device and
 * sent to the collaboration server until it has them, and those of others, fetched from it to be
 * shown. The board holds only a reference to each (see pictureRef.ts); nothing here writes the
 * board, so a picture sent after its node was taken off does not bring the node back.
 */
import { assetOf, isQuotaError } from '../platform/storage';
import type { SharedJoin } from './client';
import { MAX_PICTURE_BYTES, isPictureName, pictureAddress, sharedSrc } from './pictureRef';

/** A picture's bytes as this device keeps them, and their type. */
export interface PictureBody {
  bytes: Uint8Array;
  type: string;
}

/**
 * Where this device keeps the pictures of shared projects, by key: those put on a board here, until
 * the server has them, and those fetched or sent, so that they show again offline. A write rejects
 * when it fails (the device full, its storage blocked).
 */
export interface PictureDevice {
  load(key: string): Promise<PictureBody | null>;
  /** Keep a picture; `unsent`: one still to be sent, until `sent` says otherwise. */
  keep(key: string, body: PictureBody, unsent: boolean): Promise<void>;
  /** The server has the picture: it is no longer one to send. */
  sent(key: string): Promise<void>;
  /** The keys, under `prefix`, of the pictures still to be sent. */
  unsent(prefix: string): Promise<string[]>;
}

/**
 * How a picture of the project stands on this page. Put on the board here, and not on the server yet:
 * `unsent` (waiting to be sent: offline …), `sending`, `resending` (a try after one that failed),
 * `failed` (the server did not keep it: sent again later), `unkept` (this device could not keep it
 * either: it is on this page alone), `refused` (the server turned it away: not sent again). Not on
 * this page: `loading`, `waiting` (the server does not have it yet), `unreachable` (it could not be
 * fetched: fetched again later), `denied` (the server turned the fetch away). `shown`: on this page
 * and on the server.
 */
export type PictureStatus = 'shown' | 'unsent' | 'sending' | 'resending' | 'failed' | 'unkept' | 'refused' | 'loading' | 'waiting' | 'unreachable' | 'denied';

export interface PictureView {
  status: PictureStatus;
  /** Where the picture is shown from, once its bytes are on this page. */
  url: string | null;
  /** Why it is `failed`, `unkept`, `refused`, `unreachable` or `denied`. */
  reason: string | null;
}

/** What the pictures put on a board here and not yet on the server add to the project's status (see ShareStatus). */
interface PicturesStatus {
  unsent: number;
  /** Why one is failing to be sent: the last try that failed, until one goes through. */
  failure: string | null;
  /** Why this device could not keep one still to be sent. */
  unkept: string | null;
  /** Whether one still to be sent is being written to this device. */
  keeping: boolean;
}

/** A try that failed is followed by another after these waits, the last one repeated. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000];
const waitAfter = (failed: number): number => RETRY_MS[Math.min(failed, RETRY_MS.length - 1)];

const LOADING: PictureView = { status: 'loading', url: null, reason: null };

/** Why the server turned a request for a picture away, as the user is told it. */
const DENIALS: Record<string, string> = {
  'read-only': '閲覧のみの招待です',
  revoked: '招待が取り消されました',
  deleted: '案件が削除されています',
  'too-large': '画像が 64MB を超えています',
};

async function denialOf(res: Response): Promise<string> {
  const reason = ((await res.json().catch(() => ({}))) as { reason?: unknown }).reason;
  return (typeof reason === 'string' && DENIALS[reason]) || '案件の権限がありません';
}

/** A failure to write to this device as the user is told it. */
const deviceFailure = (e: unknown): string => (isQuotaError(e) ? '端末の空き容量が足りません' : e instanceof Error ? e.message || e.name : String(e));

const bodyOf = async (blob: Blob): Promise<PictureBody> => ({ bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type });
const blobOf = (body: PictureBody): Blob => new Blob([body.bytes as Uint8Array<ArrayBuffer>], { type: body.type });

/** A picture put on the board here, until the server has it. */
interface Outgoing {
  state: 'unsent' | 'sending' | 'failed' | 'denied';
  tries: number;
  /** Why the last try the server answered failed; kept through the tries after it. */
  reason: string | null;
  /** Why this device could not keep it. */
  unkept: string | null;
  /** Whether it is being written to this device. */
  keeping: boolean;
}

interface Picture {
  name: string;
  body: Blob | null;
  url: string | null;
  out: Outgoing | null;
  /** Whether the server is known to have it (it was sent or fetched here). */
  onServer: boolean;
  /** How fetching it went, while it is not on this page. */
  fetch: 'idle' | 'loading' | 'waiting' | 'unreachable' | 'denied';
  reason: string | null;
  view: PictureView;
  hearers: Set<() => void>;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
}

function viewOf(p: Picture): PictureView {
  const out = p.out;
  if (out) {
    if (out.state === 'denied') return { status: 'refused', url: p.url, reason: out.reason };
    if (out.unkept) return { status: 'unkept', url: p.url, reason: out.unkept };
    if (out.state === 'sending') return { status: out.tries > 1 ? 'resending' : 'sending', url: p.url, reason: null };
    return { status: out.state, url: p.url, reason: out.state === 'failed' ? out.reason : null };
  }
  if (p.body) return { status: 'shown', url: p.url, reason: null };
  return { status: p.fetch === 'idle' ? 'loading' : p.fetch, url: null, reason: p.reason };
}

/** Why a picture put on a board was not put there after all: the project was closed meanwhile. */
const CLOSED = '画像を置く前に案件を閉じました';

const sameView = (a: PictureView, b: PictureView): boolean => a.status === b.status && a.url === b.url && a.reason === b.reason;

/**
 * The pictures of the shared project `join` on this page, kept on `device` (none: on this page alone)
 * under the project and its server. Pictures put on a board here and left unsent (offline, the page
 * closed) are sent once more when the project is opened again here; the server keeps each picture
 * once, however often it is sent. `notify` is called whenever one changes how it stands.
 */
export function projectPictures(join: SharedJoin, device: PictureDevice | null, notify: () => void) {
  const pictures = new Map<string, Picture>();
  const prefix = `${join.project}@${join.server}/`;
  const keyOf = (name: string): string => prefix + name;
  const address = (name: string): string => pictureAddress(join.server, join.project, name);
  const authorization = { Authorization: `Bearer ${join.token}` };
  let closed = false;
  let sending = false;
  let sendRetries = 0;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;

  function entry(name: string): Picture {
    let p = pictures.get(name);
    if (!p) {
      p = { name, body: null, url: null, out: null, onServer: false, fetch: 'idle', reason: null, view: LOADING, hearers: new Set(), retries: 0 };
      pictures.set(name, p);
    }
    return p;
  }

  function update(p: Picture): void {
    const next = viewOf(p);
    if (sameView(p.view, next)) return;
    p.view = next;
    p.hearers.forEach((hear) => hear());
    // Not for a picture of others: the project's status counts only those put on the board here (see status()).
    if (p.out) notify();
  }

  function setBody(p: Picture, body: Blob): void {
    clearTimeout(p.timer);
    p.body = body;
    p.url = URL.createObjectURL(body);
    [p.fetch, p.reason, p.retries] = ['idle', null, 0];
    update(p);
  }

  /** Send the pictures still to be sent, one at a time; after a try that failed, the rest wait for the next. */
  async function pump(): Promise<void> {
    const p = [...pictures.values()].find((x) => x.out && x.out.state !== 'denied' && x.body);
    if (sending || closed || !p) return;
    const out = p.out!;
    sending = true;
    out.state = 'sending';
    out.tries++;
    update(p);
    let goOn = false;
    try {
      const res = await fetch(address(p.name), { method: 'PUT', headers: { ...authorization, 'Content-Type': p.body!.type }, body: p.body });
      if (res.ok) {
        p.out = null;
        p.onServer = true;
        notify();
        // Failing, it is sent again the next time the project is opened here: the server keeps it once.
        void device?.sent(keyOf(p.name)).catch(() => {});
        goOn = true;
      } else if (res.status === 403 || res.status === 413) {
        [out.state, out.reason] = ['denied', await denialOf(res)];
        goOn = true;
      } else {
        [out.state, out.reason] = ['failed', `サーバーの応答 ${res.status}`];
      }
    } catch {
      out.state = 'unsent';
    } finally {
      sending = false;
    }
    if (closed) return;
    update(p);
    if (goOn) {
      sendRetries = 0;
      return pump();
    }
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => void pump(), waitAfter(sendRetries++));
  }

  /**
   * Keep a picture still to be sent on this device, to be sent after the page is opened again; it is
   * `unkept`, saying why, until that is done.
   */
  async function keepUnsent(p: Picture, out: Outgoing): Promise<void> {
    if (!device) return;
    out.keeping = true;
    notify();
    try {
      await device.keep(keyOf(p.name), await bodyOf(p.body!), true);
      out.unkept = null;
      // Sent while it was being kept: not to be sent again the next time.
      if (p.out !== out) void device.sent(keyOf(p.name)).catch(() => {});
    } catch (e) {
      out.unkept = deviceFailure(e);
    }
    out.keeping = false;
    if (closed) return;
    update(p);
    // Not a change of how it looks (update leaves it unsaid): the project's status changed all the same.
    notify();
  }

  /** Bring a picture that is not on this page here: from this device, else from the server; fetched again later when it cannot be. */
  async function load(p: Picture): Promise<void> {
    clearTimeout(p.timer);
    p.fetch = 'loading';
    update(p);
    const kept = device && (await device.load(keyOf(p.name)).catch(() => null));
    if (closed || p.body) return;
    if (kept) return setBody(p, blobOf(kept));
    try {
      const res = await fetch(address(p.name), { headers: authorization });
      if (res.ok) {
        const body = await res.blob();
        if (closed || p.body) return;
        p.onServer = true;
        setBody(p, body);
        // Not kept, it is fetched again the next time it is shown offline.
        void bodyOf(body).then((b) => device?.keep(keyOf(p.name), b, false)).catch(() => {});
        return;
      }
      if (res.status === 403) [p.fetch, p.reason] = ['denied', await denialOf(res)];
      else [p.fetch, p.reason] = res.status === 404 ? ['waiting', null] : ['unreachable', `サーバーの応答 ${res.status}`];
    } catch {
      [p.fetch, p.reason] = ['unreachable', 'サーバーにつながりません'];
    }
    if (closed || p.body) return;
    update(p);
    if (p.fetch !== 'denied') p.timer = setTimeout(() => p.hearers.size && want(p), waitAfter(p.retries++));
  }

  function want(p: Picture): void {
    if (!closed && !p.body && p.fetch !== 'loading' && p.fetch !== 'denied') void load(p);
  }

  /** Hear of every change of how a picture stands; watched, a picture not on this page is fetched. */
  function watch(name: string, hear: () => void): () => void {
    const p = entry(name);
    p.hearers.add(hear);
    want(p);
    return () => void p.hearers.delete(hear);
  }

  // What was put on a board here and left unsent when the project was last open here.
  void (async () => {
    const keys = device ? await device.unsent(prefix).catch(() => []) : [];
    for (const key of keys) {
      const name = key.slice(prefix.length);
      const kept = isPictureName(name) ? await device!.load(key).catch(() => null) : null;
      if (closed) return;
      if (!kept) continue;
      const p = entry(name);
      p.out ??= { state: 'unsent', tries: 0, reason: null, unkept: null, keeping: false };
      if (p.body) update(p);
      else setBody(p, blobOf(kept));
    }
    void pump();
  })();

  return {
    /**
     * Keep a picture put on a board here: on this device, then sent to the server. Resolves to the
     * `src` its node holds, once it is kept (or could not be: it is then `unkept`, and still sent).
     * Rejects, in words for the user, for a kind or size of picture a shared project does not keep,
     * and once the project is closed: the board on screen is then another one.
     */
    async keep(dataUrl: string): Promise<string> {
      const picture = await assetOf(dataUrl);
      if (!picture) throw new Error('共有中のボードに置ける画像は PNG・JPEG・GIF・WebP・SVG です');
      if (picture.blob.size > MAX_PICTURE_BYTES) throw new Error('共有中のボードに置ける画像は 64MB までです');
      if (closed) throw new Error(CLOSED);
      const src = sharedSrc(picture.name);
      const p = entry(picture.name);
      if (!p.body) setBody(p, picture.blob);
      if (p.out || p.onServer) return src;
      const out: Outgoing = { state: 'unsent', tries: 0, reason: null, unkept: null, keeping: false };
      p.out = out;
      update(p);
      await keepUnsent(p, out);
      if (closed) throw new Error(CLOSED);
      void pump();
      return src;
    },
    /** How a picture stands on this page, by name. */
    view: (name: string): PictureView => pictures.get(name)?.view ?? LOADING,
    watch,
    /** A picture's bytes, fetched if need be (an export's); rejects, in words for the user, when they cannot be had now. */
    read(name: string): Promise<Blob> {
      const p = entry(name);
      return new Promise((resolve, reject) => {
        /** Whether the fetch has come to an end, one way or the other. */
        const settled = (): boolean => {
          if (p.body) resolve(p.body);
          else if (p.fetch === 'loading') return false;
          else reject(new Error(p.fetch === 'waiting' ? '画像がまだ共同編集先に届いていません' : `画像を取得できません（${p.reason ?? '閉じた案件です'}）`));
          return true;
        };
        if (p.body) return resolve(p.body);
        let stop = (): void => {};
        stop = watch(name, () => void (settled() && stop()));
        // Not fetched (turned away before, or the project closed): no change is coming.
        if (settled()) stop();
      });
    },
    /** What the pictures put on a board here and not yet sent add to the project's status. */
    status(): PicturesStatus {
      const out = [...pictures.values()].flatMap((p) => (p.out ? [p.out] : []));
      // Kept while it is sent again, as the edits' failure is: the top bar does not flip at each try.
      const failing = out.find((o) => o.reason);
      const unkept = out.find((o) => o.unkept);
      return {
        unsent: out.length,
        failure: failing ? `画像を共同編集先に保存できていません（${failing.reason}）` : null,
        unkept: unkept ? `画像を端末に保存できません（${unkept.unkept}）` : null,
        keeping: out.some((o) => o.keeping),
      };
    },
    /** A picture the server says it now keeps: fetched at once if it is waited for. */
    arrived(name: string): void {
      const p = pictures.get(name);
      if (p?.hearers.size && p.fetch !== 'loading') {
        p.retries = 0;
        want(p);
      }
    },
    /** Keep on this device, send, and fetch what could not be, now rather than at the next try. */
    retry(): void {
      sendRetries = 0;
      clearTimeout(sendTimer);
      void pump();
      for (const p of pictures.values()) {
        if (p.out?.unkept && !p.out.keeping) void keepUnsent(p, p.out);
        if (!p.hearers.size || p.fetch === 'denied') continue;
        p.retries = 0;
        want(p);
      }
    },
    /** Stop: nothing more is sent or fetched. What is still to be sent stays on this device, to be sent the next time. */
    close(): void {
      closed = true;
      clearTimeout(sendTimer);
      for (const p of pictures.values()) {
        clearTimeout(p.timer);
        if (p.url) URL.revokeObjectURL(p.url);
      }
    },
  };
}

export type SharedPictures = ReturnType<typeof projectPictures>;
