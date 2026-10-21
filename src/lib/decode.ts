/**
 * Bytes → text for the browser host (dev server, tests, web demo). The desktop app does this in
 * Rust (src-tauri/src/encoding.rs) with a real legacy-encoding detector; here the fallback for
 * non-UTF-8 text is Windows-1252, the usual encoding of Excel/Notepad exports.
 * Returns null for binary files.
 */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: string } | null {
  const head = bytes.subarray(0, 8000);
  let encoding: string;
  let skip = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) [encoding, skip] = ["UTF-8", 3];
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) [encoding, skip] = ["UTF-16LE", 2];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) [encoding, skip] = ["UTF-16BE", 2];
  else if (head.includes(0)) {
    const utf16 = sniffUtf16(head);
    if (!utf16) return null;
    encoding = utf16;
  } else if (isUtf8(bytes)) encoding = "UTF-8";
  else encoding = "windows-1252";
  // ignoreBOM: we already skipped it, and a second one is content.
  const text = new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes.subarray(skip));
  return { text, encoding };
}

/** UTF-16 without a byte-order mark: mostly-ASCII text has a zero in every other byte. */
function sniffUtf16(sample: Uint8Array): string | null {
  const pairs = Math.floor(sample.length / 2);
  if (pairs < 2) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < pairs * 2; i++) if (sample[i] === 0) i % 2 ? odd++ : even++;
  const mostly = (n: number) => n * 10 >= pairs * 4;
  const rarely = (n: number) => n * 20 <= pairs;
  const enc = mostly(odd) && rarely(even) ? "UTF-16LE" : mostly(even) && rarely(odd) ? "UTF-16BE" : null;
  if (!enc) return null;
  // The zero pattern can match binary data too, so the result must read as text.
  const text = new TextDecoder(enc).decode(sample.subarray(0, pairs * 2));
  if ((text.match(/�/g)?.length ?? 0) > 1) return null;
  const control = text.match(/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/g)?.length ?? 0;
  return control * 100 <= text.length ? enc : null;
}

/** Valid UTF-8, allowing a character cut off at the end. */
function isUtf8(bytes: Uint8Array): boolean {
  const fatal = new TextDecoder("utf-8", { fatal: true });
  try {
    fatal.decode(bytes);
    return true;
  } catch {
    // Retry without the last up-to-3 bytes in case a character was cut off.
    for (let cut = 1; cut <= 3 && cut < bytes.length; cut++) {
      try {
        fatal.decode(bytes.subarray(0, bytes.length - cut));
        return true;
      } catch {
        /* keep trying */
      }
    }
    return false;
  }
}
