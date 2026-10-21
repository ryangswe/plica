import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeBytes } from "../../src/lib/decode";

const utf16 = (text: string, littleEndian: boolean) => {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    out[i * 2 + (littleEndian ? 0 : 1)] = u & 0xff;
    out[i * 2 + (littleEndian ? 1 : 0)] = u >> 8;
  }
  return out;
};
const withPrefix = (prefix: number[], body: Uint8Array) => new Uint8Array([...prefix, ...body]);
const fixture = (name: string) => new Uint8Array(readFileSync(`${process.cwd()}/tests/fixtures/${name}`));

describe("decodeBytes", () => {
  const csv = "name,price\nCafé,€5\n";

  it("uses the byte-order mark", () => {
    expect(decodeBytes(withPrefix([0xff, 0xfe], utf16(csv, true)))).toEqual({ text: csv, encoding: "UTF-16LE" });
    expect(decodeBytes(withPrefix([0xfe, 0xff], utf16(csv, false)))).toEqual({ text: csv, encoding: "UTF-16BE" });
    expect(decodeBytes(withPrefix([0xef, 0xbb, 0xbf], new TextEncoder().encode(csv)))).toEqual({ text: csv, encoding: "UTF-8" });
  });

  it("recognizes UTF-16 without a BOM instead of calling it binary", () => {
    expect(decodeBytes(utf16(csv, true))).toEqual({ text: csv, encoding: "UTF-16LE" });
    expect(decodeBytes(utf16(csv, false))).toEqual({ text: csv, encoding: "UTF-16BE" });
  });

  it("falls back to Windows-1252 for text that isn't UTF-8", () => {
    const got = decodeBytes(fixture("excel-1252.csv"));
    expect(got?.encoding).toBe("windows-1252");
    expect(got?.text).toContain("Café Müller;Zürich;€ 4,50");
    expect(got?.text).toContain("“Smart” quotes");
  });

  it("keeps UTF-8 when a character is cut off at the end (truncated files)", () => {
    const bytes = new TextEncoder().encode("abc é");
    expect(decodeBytes(bytes.subarray(0, bytes.length - 1))?.encoding).toBe("UTF-8");
  });

  it("still detects binary files", () => {
    expect(decodeBytes(new Uint8Array([1, 2, 0, 3]))).toBeNull();
    expect(decodeBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48]))).toBeNull();
  });

  it("decodes the Excel UTF-16 fixture", () => {
    const got = decodeBytes(fixture("excel-utf16.csv"));
    expect(got?.encoding).toBe("UTF-16LE");
    expect(got?.text.startsWith("city,country,note")).toBe(true);
    expect(got?.text).toContain("東京,Japan,日本語");
  });
});
