//
// codec.ts — Character-encoding conversion (replaces iconv / readstat_convert.c)
//
// The default codec uses the platform TextDecoder (full-ICU, available in Node
// 18+ and modern browsers) for decoding, and hand-rolled encoders for the
// single-byte encodings that the writers need. A custom Codec (e.g. backed by
// iconv-lite) can be injected to broaden encoding support for writing.
//

export interface Codec {
  /** Decode raw bytes in the given encoding to a JS string. */
  decode(bytes: Uint8Array, encoding: string): string;
  /** Encode a JS string to raw bytes in the given encoding. */
  encode(text: string, encoding: string): Uint8Array;
}

/** Normalize an iconv-style encoding name to a WHATWG TextDecoder label. */
export function normalizeEncoding(name: string | null | undefined): string {
  if (!name) return "utf-8";
  let key = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Common aliases used across SPSS / SAS / Stata files.
  const map: Record<string, string> = {
    UTF8: "utf-8",
    UTF8BOM: "utf-8",
    USASCII: "ascii",
    ASCII: "ascii",
    ANSIX341968: "ascii",
    ISO88591: "iso-8859-1",
    LATIN1: "iso-8859-1",
    L1: "iso-8859-1",
    ISO88592: "iso-8859-2",
    LATIN2: "iso-8859-2",
    ISO88593: "iso-8859-3",
    ISO88594: "iso-8859-4",
    ISO88595: "iso-8859-5",
    ISO88596: "iso-8859-6",
    ISO88597: "iso-8859-7",
    ISO88598: "iso-8859-8",
    ISO88599: "windows-1254",
    ISO885910: "iso-8859-10",
    ISO885911: "windows-874",
    ISO885913: "iso-8859-13",
    ISO885914: "iso-8859-14",
    ISO885915: "iso-8859-15",
    ISO885916: "iso-8859-16",
    CP1250: "windows-1250",
    WINDOWS1250: "windows-1250",
    CP1251: "windows-1251",
    WINDOWS1251: "windows-1251",
    CP1252: "windows-1252",
    WINDOWS1252: "windows-1252",
    CP1253: "windows-1253",
    WINDOWS1253: "windows-1253",
    CP1254: "windows-1254",
    WINDOWS1254: "windows-1254",
    CP1255: "windows-1255",
    WINDOWS1255: "windows-1255",
    CP1256: "windows-1256",
    WINDOWS1256: "windows-1256",
    CP1257: "windows-1257",
    WINDOWS1257: "windows-1257",
    CP1258: "windows-1258",
    WINDOWS1258: "windows-1258",
    KOI8R: "koi8-r",
    KOI8U: "koi8-u",
    MACROMAN: "macintosh",
    MACINTOSH: "macintosh",
    SHIFTJIS: "shift_jis",
    SJIS: "shift_jis",
    MSKANJI: "shift_jis",
    EUCJP: "euc-jp",
    EUCKR: "euc-kr",
    GB2312: "gbk",
    GB18030: "gb18030",
    GBK: "gbk",
    BIG5: "big5",
    BIG5HKSCS: "big5",
    WINDOWS874: "windows-874",
    TIS620: "windows-874",
    CP874: "windows-874",
    CP437: "ibm437",
    CP850: "ibm850",
    CP866: "ibm866",
    IBM866: "ibm866",
  };
  return map[key] ?? name.toLowerCase();
}

const SINGLE_BYTE_ENCODINGS = new Set([
  "ascii",
  "iso-8859-1",
  "iso-8859-2",
  "iso-8859-3",
  "iso-8859-4",
  "iso-8859-5",
  "iso-8859-6",
  "iso-8859-7",
  "iso-8859-8",
  "iso-8859-10",
  "iso-8859-13",
  "iso-8859-14",
  "iso-8859-15",
  "iso-8859-16",
  "windows-1250",
  "windows-1251",
  "windows-1252",
  "windows-1253",
  "windows-1254",
  "windows-1255",
  "windows-1256",
  "windows-1257",
  "windows-1258",
  "windows-874",
  "koi8-r",
  "koi8-u",
  "macintosh",
  "ibm866",
]);

type TextDecoderInstance = InstanceType<typeof TextDecoder>;

export class DefaultCodec implements Codec {
  private decoders = new Map<string, TextDecoderInstance>();
  private encoders = new Map<string, Map<string, number>>();
  private utf8Encoder = new TextEncoder();

  private decoderFor(label: string): TextDecoderInstance {
    let d = this.decoders.get(label);
    if (!d) {
      d = new TextDecoder(label, { fatal: false });
      this.decoders.set(label, d);
    }
    return d;
  }

  decode(bytes: Uint8Array, encoding: string): string {
    const label = normalizeEncoding(encoding);
    if (label === "utf-8" || label === "utf8") {
      return this.decoderFor("utf-8").decode(bytes);
    }
    try {
      return this.decoderFor(label).decode(bytes);
    } catch {
      // Unknown label — fall back to latin1 (byte-preserving).
      return this.decoderFor("iso-8859-1").decode(bytes);
    }
  }

  /** Build a reverse map (codepoint -> byte) for a single-byte encoding. */
  private reverseTable(label: string): Map<string, number> {
    let table = this.encoders.get(label);
    if (table) return table;
    table = new Map();
    const dec = this.decoderFor(label);
    const one = new Uint8Array(1);
    for (let b = 0; b < 256; b++) {
      one[0] = b;
      const ch = dec.decode(one, { stream: false });
      // Only keep the first mapping for a given char (lowest byte wins),
      // and skip the replacement character.
      if (ch.length === 1 && ch !== "�" && !table.has(ch)) {
        table.set(ch, b);
      }
    }
    this.encoders.set(label, table);
    return table;
  }

  encode(text: string, encoding: string): Uint8Array {
    const label = normalizeEncoding(encoding);
    if (label === "utf-8" || label === "utf8") {
      return this.utf8Encoder.encode(text);
    }
    if (SINGLE_BYTE_ENCODINGS.has(label)) {
      const table = this.reverseTable(label);
      const out = new Uint8Array(text.length);
      let n = 0;
      for (const ch of text) {
        if (ch.codePointAt(0)! > 0xffff) {
          // outside BMP: cannot fit a single-byte encoding
          out[n++] = 0x3f; // '?'
          continue;
        }
        const b = table.get(ch);
        out[n++] = b === undefined ? 0x3f : b;
      }
      return out.subarray(0, n);
    }
    // Multi-byte non-UTF-8 encodings are not supported by the default encoder.
    // Fall back to UTF-8 bytes; inject a custom Codec (iconv-lite) for fidelity.
    return this.utf8Encoder.encode(text);
  }
}

export const defaultCodec: Codec = new DefaultCodec();

/**
 * Port of readstat_convert(): strip trailing spaces and NULs, then decode.
 * `maxLen` (dst_len - 1 in C) bounds the *decoded* result is not enforced here
 * because JS strings are not fixed-width; callers that need the C length checks
 * use the raw byte length instead.
 */
export function convertString(
  codec: Codec,
  src: Uint8Array,
  encoding: string,
  offset = 0,
  len = src.length - offset,
): string {
  let srcLen = len;
  while (srcLen > 0) {
    const c = src[offset + srcLen - 1];
    if (c === 0x20 || c === 0x00) {
      srcLen--;
    } else {
      break;
    }
  }
  if (srcLen === 0) return "";
  return codec.decode(src.subarray(offset, offset + srcLen), encoding);
}
