//
// sas/sas-header.ts — SAS7BDAT/SAS7BCAT header parsing and shared constants
// (port of readstat_sas.c header logic)
//

import { ReadStatError, ReadStatException } from "../errors.js";
import { IoContext, ioReadExact } from "../io.js";
import { ReadStatSeek } from "../types.js";

export const SAS_ENDIAN_BIG = 0x00;
export const SAS_ENDIAN_LITTLE = 0x01;
export const SAS_ALIGNMENT_OFFSET_4 = 0x33;

export const SAS_COLUMN_TYPE_NUM = 0x01;
export const SAS_COLUMN_TYPE_CHR = 0x02;

export const SAS_PAGE_HEADER_SIZE_32BIT = 24;
export const SAS_PAGE_HEADER_SIZE_64BIT = 40;
export const SAS_SUBHEADER_POINTER_SIZE_32BIT = 12;
export const SAS_SUBHEADER_POINTER_SIZE_64BIT = 24;

export const SAS_COMPRESSION_NONE = 0x00;
export const SAS_COMPRESSION_TRUNC = 0x01;
export const SAS_COMPRESSION_ROW = 0x04;
export const SAS_COMPRESSION_SIGNATURE_RLE = "SASYZCRL";
export const SAS_COMPRESSION_SIGNATURE_RDC = "SASYZCR2";

export const SAS_PAGE_TYPE_META = 0x0000;
export const SAS_PAGE_TYPE_DATA = 0x0100;
export const SAS_PAGE_TYPE_MIX = 0x0200;
export const SAS_PAGE_TYPE_AMD = 0x0400;
export const SAS_PAGE_TYPE_MASK = 0x0f00;
export const SAS_PAGE_TYPE_COMP = 0x9000;

export const READSTAT_VENDOR_STAT_TRANSFER = 0;
export const READSTAT_VENDOR_SAS = 1;

export const SAS_DEFAULT_STRING_ENCODING = "WINDOWS-1252";

export const SAS7BDAT_MAGIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc2, 0xea, 0x81, 0x60,
  0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00, 0x09, 0xc7, 0x31, 0x8c, 0x18, 0x1f, 0x10, 0x11,
]);
export const SAS7BCAT_MAGIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc2, 0xea, 0x81, 0x63,
  0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00, 0x09, 0xc7, 0x31, 0x8c, 0x18, 0x1f, 0x10, 0x11,
]);

export const SAS_CHARSET_TABLE: Record<number, string> = {
  0: SAS_DEFAULT_STRING_ENCODING, 20: "UTF-8", 28: "US-ASCII", 29: "ISO-8859-1",
  30: "ISO-8859-2", 31: "ISO-8859-3", 32: "ISO-8859-4", 33: "ISO-8859-5",
  34: "ISO-8859-6", 35: "ISO-8859-7", 36: "ISO-8859-8", 37: "ISO-8859-9",
  39: "ISO-8859-11", 40: "ISO-8859-15", 41: "CP437", 42: "CP850", 43: "CP852",
  44: "CP857", 45: "CP858", 46: "CP862", 47: "CP864", 48: "CP865", 49: "CP866",
  50: "CP869", 51: "CP874", 55: "CP720", 56: "CP737", 57: "CP775", 58: "CP860",
  59: "CP863", 60: "WINDOWS-1250", 61: "WINDOWS-1251", 62: "WINDOWS-1252",
  63: "WINDOWS-1253", 64: "WINDOWS-1254", 65: "WINDOWS-1255", 66: "WINDOWS-1256",
  67: "WINDOWS-1257", 68: "WINDOWS-1258", 69: "MACROMAN", 118: "CP950",
  119: "EUC-TW", 123: "BIG-5", 125: "GB18030", 126: "WINDOWS-936",
  134: "EUC-JP", 136: "CP949", 137: "CP942", 138: "CP932", 140: "EUC-KR",
  141: "CP949", 142: "CP949", 204: SAS_DEFAULT_STRING_ENCODING, 205: "GB18030",
  227: "ISO-8859-14", 242: "ISO-8859-13", 248: "SHIFT_JISX0213",
};

export interface SasHeaderInfo {
  littleEndian: boolean;
  u64: boolean;
  vendor: number;
  majorVersion: number;
  minorVersion: number;
  revision: number;
  pad1: number;
  pageSize: number;
  pageHeaderSize: number;
  subheaderPointerSize: number;
  pageCount: number;
  headerSize: number;
  creationTime: number;
  modificationTime: number;
  tableName: Uint8Array; // raw 32 bytes
  encoding: string;
}

export function sasRead2(b: Uint8Array, off: number, le: boolean): number {
  return new DataView(b.buffer, b.byteOffset + off, 2).getUint16(0, le);
}
export function sasRead4(b: Uint8Array, off: number, le: boolean): number {
  return new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0, le);
}
export function sasRead8(b: Uint8Array, off: number, le: boolean): bigint {
  return new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, le);
}

function sasEpoch(): number {
  return -3653 * 86400;
}
function sasConvertTime(time: number, diff: number, epoch: number): number {
  let t = time - diff + epoch;
  if (Number.isNaN(t)) return 0;
  return Math.trunc(t);
}

/** Returns 0 (bdat), 1 (bcat), or -1 (neither) for the leading magic. */
export function sasMagicKind(magic: Uint8Array): number {
  const eq = (m: Uint8Array) => {
    for (let i = 0; i < 32; i++) if (magic[i] !== m[i]) return false;
    return true;
  };
  if (eq(SAS7BDAT_MAGIC)) return 0;
  if (eq(SAS7BCAT_MAGIC)) return 1;
  return -1;
}

export function sasReadHeader(io: IoContext, errorHandler?: (m: string) => void): SasHeaderInfo {
  const hinfo: SasHeaderInfo = {
    littleEndian: true, u64: false, vendor: READSTAT_VENDOR_SAS, majorVersion: 0,
    minorVersion: 0, revision: 0, pad1: 0, pageSize: 0, pageHeaderSize: 0,
    subheaderPointerSize: 0, pageCount: 0, headerSize: 0, creationTime: 0,
    modificationTime: 0, tableName: new Uint8Array(32), encoding: SAS_DEFAULT_STRING_ENCODING,
  };
  const epoch = sasEpoch();

  const headerStart = ioReadExact(io, 164);
  if (sasMagicKind(headerStart) === -1) throw new ReadStatException(ReadStatError.ERROR_PARSE);

  const a2 = headerStart[32];
  const a1 = headerStart[35];
  if (a1 === SAS_ALIGNMENT_OFFSET_4) hinfo.pad1 = 4;
  if (a2 === SAS_ALIGNMENT_OFFSET_4) hinfo.u64 = true;

  const endian = headerStart[37];
  if (endian === SAS_ENDIAN_BIG) hinfo.littleEndian = false;
  else if (endian === SAS_ENDIAN_LITTLE) hinfo.littleEndian = true;
  else throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const le = hinfo.littleEndian;

  const encoding = headerStart[70];
  const encName = SAS_CHARSET_TABLE[encoding];
  if (!encName) {
    errorHandler?.(`Unsupported character set code: ${encoding}`);
    throw new ReadStatException(ReadStatError.ERROR_UNSUPPORTED_CHARSET);
  }
  hinfo.encoding = encName;
  hinfo.tableName = headerStart.slice(92, 124);

  if (io.seek(hinfo.pad1, ReadStatSeek.CUR) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);

  const times = ioReadExact(io, 32);
  const tdv = new DataView(times.buffer, times.byteOffset, 32);
  const creationTime = tdv.getFloat64(0, le);
  const modificationTime = tdv.getFloat64(8, le);
  const creationTimeDiff = tdv.getFloat64(16, le);
  const modificationTimeDiff = tdv.getFloat64(24, le);
  hinfo.creationTime = sasConvertTime(creationTime, creationTimeDiff, epoch);
  hinfo.modificationTime = sasConvertTime(modificationTime, modificationTimeDiff, epoch);

  const sizes = ioReadExact(io, 8);
  const sdv = new DataView(sizes.buffer, sizes.byteOffset, 8);
  hinfo.headerSize = sdv.getUint32(0, le);
  hinfo.pageSize = sdv.getUint32(4, le);
  if (hinfo.headerSize < 1024 || hinfo.pageSize < 1024) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (hinfo.headerSize > 1 << 24 || hinfo.pageSize > 1 << 24) throw new ReadStatException(ReadStatError.ERROR_PARSE);

  if (hinfo.u64) {
    hinfo.pageHeaderSize = SAS_PAGE_HEADER_SIZE_64BIT;
    hinfo.subheaderPointerSize = SAS_SUBHEADER_POINTER_SIZE_64BIT;
    const pc = ioReadExact(io, 8);
    hinfo.pageCount = Number(new DataView(pc.buffer, pc.byteOffset, 8).getBigUint64(0, le));
  } else {
    hinfo.pageHeaderSize = SAS_PAGE_HEADER_SIZE_32BIT;
    hinfo.subheaderPointerSize = SAS_SUBHEADER_POINTER_SIZE_32BIT;
    const pc = ioReadExact(io, 4);
    hinfo.pageCount = new DataView(pc.buffer, pc.byteOffset, 4).getUint32(0, le);
  }
  if (hinfo.pageCount > 1 << 24) throw new ReadStatException(ReadStatError.ERROR_PARSE);

  if (io.seek(8, ReadStatSeek.CUR) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);
  const headerEnd = ioReadExact(io, 120);
  const release = latinStr(headerEnd, 0, 8);
  const m = /^(.)\.(\d{4})(.)(\d)/.exec(release);
  if (!m) throw new ReadStatException(ReadStatError.ERROR_PARSE);
  const major = m[1];
  const minor = parseInt(m[2], 10);
  const revisionTag = m[3];
  const revision = parseInt(m[4], 10);
  if (major >= "1" && major <= "9") hinfo.majorVersion = major.charCodeAt(0) - 0x30;
  else if (major === "V") hinfo.majorVersion = 9;
  else throw new ReadStatException(ReadStatError.ERROR_PARSE);
  if (revisionTag !== "M" && revisionTag !== "J") throw new ReadStatException(ReadStatError.ERROR_PARSE);
  hinfo.minorVersion = minor;
  hinfo.revision = revision;
  hinfo.vendor = (major === "8" || major === "9") && minor === 0 && revision === 0 ? READSTAT_VENDOR_STAT_TRANSFER : READSTAT_VENDOR_SAS;

  if (io.seek(hinfo.headerSize, ReadStatSeek.SET) === -1) throw new ReadStatException(ReadStatError.ERROR_SEEK);

  return hinfo;
}

function latinStr(b: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

export function sasSubheaderRemainder(len: number, signatureLen: number): number {
  return len - (4 + 2 * signatureLen);
}
