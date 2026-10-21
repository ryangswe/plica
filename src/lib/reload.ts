/**
 * Re-read a watched file after it changed, retrying briefly: editors that save by delete + rename leave
 * a moment where the file doesn't exist. Only a file that stays unreadable counts as gone.
 */
export async function readWithRetry<T>(
  read: () => Promise<T>,
  waits: number[] = [0, 300, 1000],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let error = "";
  for (const ms of waits) {
    if (ms) await sleep(ms);
    try {
      return { ok: true, value: await read() };
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    }
  }
  return { ok: false, error };
}

/** Plain-words explanation for a read error on a file that was open. */
export function staleMessage(error: string): string {
  const why = /no such file|not found|os error 2\b|cannot find/i.test(error)
    ? "This file was moved or deleted."
    : /permission|denied|os error 13\b/i.test(error)
      ? "Plica isn't allowed to read this file anymore."
      : "Plica can't read this file right now.";
  return `${why} You're seeing the last version that was loaded.`;
}
