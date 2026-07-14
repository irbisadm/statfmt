//
// stata/dta.ts — DTA format constants and version configuration
// (port of readstat_dta.h / readstat_dta.c)
//

import { ReadStatType, ReadStatEndian } from "../types.js";
import { ReadStatError, ReadStatException } from "../errors.js";

export const DTA_MIN_VERSION = 104;
export const DTA_MAX_VERSION = 119;

export const DTA_HILO = 0x01; // big-endian
export const DTA_LOHI = 0x02; // little-endian

// max representable values (below the missing markers)
export const DTA_OLD_MAX_INT8 = 0x7e;
export const DTA_OLD_MAX_INT16 = 0x7ffe;
export const DTA_OLD_MAX_INT32 = 0x7ffffffe;
export const DTA_OLD_MAX_FLOAT = 0x7effffff;
export const DTA_OLD_MAX_DOUBLE = 0x7fdfffffffffffffn;

export const DTA_OLD_MISSING_INT8 = 0x7f;
export const DTA_OLD_MISSING_INT16 = 0x7fff;
export const DTA_OLD_MISSING_INT32 = 0x7fffffff;
export const DTA_OLD_MISSING_FLOAT = 0x7f000000;
export const DTA_OLD_MISSING_DOUBLE = 0x7fe0000000000000n;

export const DTA_113_MAX_INT8 = 0x64;
export const DTA_113_MAX_INT16 = 0x7fe4;
export const DTA_113_MAX_INT32 = 0x7fffffe4;
export const DTA_113_MAX_FLOAT = 0x7effffff;
export const DTA_113_MAX_DOUBLE = 0x7fdfffffffffffffn;

export const DTA_113_MISSING_INT8 = 0x65;
export const DTA_113_MISSING_INT16 = 0x7fe5;
export const DTA_113_MISSING_INT32 = 0x7fffffe5;
export const DTA_113_MISSING_FLOAT = 0x7f000000;
export const DTA_113_MISSING_DOUBLE = 0x7fe0000000000000n;

export const DTA_113_MISSING_INT8_A = DTA_113_MISSING_INT8 + 1;
export const DTA_113_MISSING_INT16_A = DTA_113_MISSING_INT16 + 1;
export const DTA_113_MISSING_INT32_A = DTA_113_MISSING_INT32 + 1;
export const DTA_113_MISSING_FLOAT_A = DTA_113_MISSING_FLOAT + 0x0800;
export const DTA_113_MISSING_DOUBLE_A = DTA_113_MISSING_DOUBLE + 0x010000000000n;

export const DTA_GSO_TYPE_BINARY = 0x81;
export const DTA_GSO_TYPE_ASCII = 0x82;

export const DTA_117_TYPE_CODE_INT8 = 0xfffa;
export const DTA_117_TYPE_CODE_INT16 = 0xfff9;
export const DTA_117_TYPE_CODE_INT32 = 0xfff8;
export const DTA_117_TYPE_CODE_FLOAT = 0xfff7;
export const DTA_117_TYPE_CODE_DOUBLE = 0xfff6;
export const DTA_117_TYPE_CODE_STRL = 0x8000;

export const DTA_111_TYPE_CODE_INT8 = 0xfb;
export const DTA_111_TYPE_CODE_INT16 = 0xfc;
export const DTA_111_TYPE_CODE_INT32 = 0xfd;
export const DTA_111_TYPE_CODE_FLOAT = 0xfe;
export const DTA_111_TYPE_CODE_DOUBLE = 0xff;

export const DTA_OLD_TYPE_CODE_INT8 = "b".charCodeAt(0);
export const DTA_OLD_TYPE_CODE_INT16 = "i".charCodeAt(0);
export const DTA_OLD_TYPE_CODE_INT32 = "l".charCodeAt(0);
export const DTA_OLD_TYPE_CODE_FLOAT = "f".charCodeAt(0);
export const DTA_OLD_TYPE_CODE_DOUBLE = "d".charCodeAt(0);

/** Per-version field-length configuration (port of dta_ctx_init). */
export class DtaConfig {
  dsFormat: number;
  le: boolean; // file byte order: true = little-endian (LOHI)
  endianness: ReadStatEndian;
  machineIsTwosComplement = false; // hard-coded 0 upstream

  fmtlistEntryLen = 0;
  typlistVersion = 0;
  dataLabelLenLen = 0;
  strlVLen = 0;
  strlOLen = 0;
  expansionLenLen = 0;
  lbllistEntryLen = 0;
  variableNameLen = 0;
  chMetadataLen = 0;
  variableLabelsEntryLen = 0;
  dataLabelLen = 0;
  timestampLen = 0;
  valueLabelTableLenLen = 0;
  valueLabelTableLabnameLen = 0;
  valueLabelTablePaddingLen = 0;
  typlistEntryLen = 0;
  fileIsXmlish = false;
  supportsTaggedMissing = false;

  maxInt8 = 0;
  maxInt16 = 0;
  maxInt32 = 0;
  maxFloat = 0;
  maxDouble = 0n;

  srtlistLen = 0;

  constructor(dsFormat: number, byteorder: number, nvar: number) {
    if (dsFormat < DTA_MIN_VERSION || dsFormat > DTA_MAX_VERSION) {
      throw new ReadStatException(ReadStatError.ERROR_UNSUPPORTED_FILE_FORMAT_VERSION);
    }
    this.dsFormat = dsFormat;
    this.le = byteorder === DTA_LOHI;
    this.endianness = this.le ? ReadStatEndian.LITTLE : ReadStatEndian.BIG;

    if (dsFormat < 105) this.fmtlistEntryLen = 7;
    else if (dsFormat < 114) this.fmtlistEntryLen = 12;
    else if (dsFormat < 118) this.fmtlistEntryLen = 49;
    else this.fmtlistEntryLen = 57;

    if (dsFormat >= 117) this.typlistVersion = 117;
    else if (dsFormat >= 111) this.typlistVersion = 111;
    else this.typlistVersion = 0;

    if (dsFormat >= 118) {
      this.dataLabelLenLen = 2;
      this.strlVLen = 2;
      this.strlOLen = 6;
    } else if (dsFormat >= 117) {
      this.dataLabelLenLen = 1;
      this.strlVLen = 4;
      this.strlOLen = 4;
    }

    if (dsFormat < 105) this.expansionLenLen = 0;
    else if (dsFormat < 110) this.expansionLenLen = 2;
    else this.expansionLenLen = 4;

    if (dsFormat < 110) {
      this.lbllistEntryLen = 9;
      this.variableNameLen = 9;
      this.chMetadataLen = 9;
    } else if (dsFormat < 118) {
      this.lbllistEntryLen = 33;
      this.variableNameLen = 33;
      this.chMetadataLen = 33;
    } else {
      this.lbllistEntryLen = 129;
      this.variableNameLen = 129;
      this.chMetadataLen = 129;
    }

    if (dsFormat < 108) {
      this.variableLabelsEntryLen = 32;
      this.dataLabelLen = 32;
    } else if (dsFormat < 118) {
      this.variableLabelsEntryLen = 81;
      this.dataLabelLen = 81;
    } else {
      this.variableLabelsEntryLen = 321;
      this.dataLabelLen = 321;
    }

    if (dsFormat < 105) {
      this.timestampLen = 0;
      this.valueLabelTableLenLen = 2;
      this.valueLabelTableLabnameLen = 12;
      this.valueLabelTablePaddingLen = 2;
    } else {
      this.timestampLen = 18;
      this.valueLabelTableLenLen = 4;
      this.valueLabelTableLabnameLen = dsFormat < 118 ? 33 : 129;
      this.valueLabelTablePaddingLen = 3;
    }

    if (dsFormat < 117) {
      this.typlistEntryLen = 1;
      this.fileIsXmlish = false;
    } else {
      this.typlistEntryLen = 2;
      this.fileIsXmlish = true;
    }

    if (dsFormat < 113) {
      this.maxInt8 = DTA_OLD_MAX_INT8;
      this.maxInt16 = DTA_OLD_MAX_INT16;
      this.maxInt32 = DTA_OLD_MAX_INT32;
      this.maxFloat = DTA_OLD_MAX_FLOAT;
      this.maxDouble = DTA_OLD_MAX_DOUBLE;
    } else {
      this.maxInt8 = DTA_113_MAX_INT8;
      this.maxInt16 = DTA_113_MAX_INT16;
      this.maxInt32 = DTA_113_MAX_INT32;
      this.maxFloat = DTA_113_MAX_FLOAT;
      this.maxDouble = DTA_113_MAX_DOUBLE;
      this.supportsTaggedMissing = true;
    }

    this.srtlistLen = dsFormat < 119 ? (nvar + 1) * 2 : (nvar + 1) * 4;
  }
}

export interface DtaTypeInfo {
  maxLen: number;
  type: ReadStatType;
}

/** Map a DTA type code to (storage width, ReadStat type). */
export function dtaTypeInfo(typecode: number, cfg: DtaConfig): DtaTypeInfo {
  let len = 0;
  let type = ReadStatType.STRING;
  if (cfg.typlistVersion === 111) {
    switch (typecode) {
      case DTA_111_TYPE_CODE_INT8: len = 1; type = ReadStatType.INT8; break;
      case DTA_111_TYPE_CODE_INT16: len = 2; type = ReadStatType.INT16; break;
      case DTA_111_TYPE_CODE_INT32: len = 4; type = ReadStatType.INT32; break;
      case DTA_111_TYPE_CODE_FLOAT: len = 4; type = ReadStatType.FLOAT; break;
      case DTA_111_TYPE_CODE_DOUBLE: len = 8; type = ReadStatType.DOUBLE; break;
      default: len = typecode; type = ReadStatType.STRING; break;
    }
  } else if (cfg.typlistVersion === 117) {
    switch (typecode) {
      case DTA_117_TYPE_CODE_INT8: len = 1; type = ReadStatType.INT8; break;
      case DTA_117_TYPE_CODE_INT16: len = 2; type = ReadStatType.INT16; break;
      case DTA_117_TYPE_CODE_INT32: len = 4; type = ReadStatType.INT32; break;
      case DTA_117_TYPE_CODE_FLOAT: len = 4; type = ReadStatType.FLOAT; break;
      case DTA_117_TYPE_CODE_DOUBLE: len = 8; type = ReadStatType.DOUBLE; break;
      case DTA_117_TYPE_CODE_STRL: len = 8; type = ReadStatType.STRING_REF; break;
      default: len = typecode; type = ReadStatType.STRING; break;
    }
  } else if (typecode < 0x7f) {
    switch (typecode) {
      case DTA_OLD_TYPE_CODE_INT8: len = 1; type = ReadStatType.INT8; break;
      case DTA_OLD_TYPE_CODE_INT16: len = 2; type = ReadStatType.INT16; break;
      case DTA_OLD_TYPE_CODE_INT32: len = 4; type = ReadStatType.INT32; break;
      case DTA_OLD_TYPE_CODE_FLOAT: len = 4; type = ReadStatType.FLOAT; break;
      case DTA_OLD_TYPE_CODE_DOUBLE: len = 8; type = ReadStatType.DOUBLE; break;
      default: throw new DtaTypeError();
    }
  } else {
    len = typecode - 0x7f;
    type = ReadStatType.STRING;
  }
  return { maxLen: len, type };
}

export class DtaTypeError extends Error {
  code = ReadStatError.ERROR_PARSE;
  constructor() {
    super("Invalid DTA type code");
  }
}
