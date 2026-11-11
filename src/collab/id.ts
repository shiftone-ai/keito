/** An id that stays unique across clients without a secure context (randomUUID needs one; a LAN address is not). */
export function uniqueId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
