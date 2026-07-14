//
// spss/sav.ts — SAV format constants and record layouts (port of readstat_sav.h)
//

export const SAV_RECORD_TYPE_VARIABLE = 2;
export const SAV_RECORD_TYPE_VALUE_LABEL = 3;
export const SAV_RECORD_TYPE_VALUE_LABEL_VARIABLES = 4;
export const SAV_RECORD_TYPE_DOCUMENT = 6;
export const SAV_RECORD_TYPE_HAS_DATA = 7;
export const SAV_RECORD_TYPE_DICT_TERMINATION = 999;

export const SAV_RECORD_SUBTYPE_INTEGER_INFO = 3;
export const SAV_RECORD_SUBTYPE_FP_INFO = 4;
export const SAV_RECORD_SUBTYPE_MULTIPLE_RESPONSE_SETS = 7;
export const SAV_RECORD_SUBTYPE_PRODUCT_INFO = 10;
export const SAV_RECORD_SUBTYPE_VAR_DISPLAY = 11;
export const SAV_RECORD_SUBTYPE_LONG_VAR_NAME = 13;
export const SAV_RECORD_SUBTYPE_VERY_LONG_STR = 14;
export const SAV_RECORD_SUBTYPE_NUMBER_OF_CASES = 16;
export const SAV_RECORD_SUBTYPE_DATA_FILE_ATTRS = 17;
export const SAV_RECORD_SUBTYPE_VARIABLE_ATTRS = 18;
export const SAV_RECORD_SUBTYPE_CHAR_ENCODING = 20;
export const SAV_RECORD_SUBTYPE_LONG_STRING_VALUE_LABELS = 21;
export const SAV_RECORD_SUBTYPE_LONG_STRING_MISSING_VALUES = 22;
export const SAV_RECORD_SUBTYPE_MULTIPLE_RESPONSE_SETS_ALT = 19;

export const SAV_FLOATING_POINT_REP_IEEE = 1;
export const SAV_FLOATING_POINT_REP_IBM = 2;
export const SAV_FLOATING_POINT_REP_VAX = 3;

export const SAV_ENDIANNESS_BIG = 1;
export const SAV_ENDIANNESS_LITTLE = 2;

// struct sizes (packed)
export const SAV_HEADER_SIZE = 176; // sav_file_header_record_t
export const SAV_VARIABLE_RECORD_SIZE = 28; // sav_variable_record_t
export const SAV_INFO_RECORD_SIZE = 16; // sav_info_record_t (4x int32)

export const SAV_LABEL_NAME_PREFIX = "@(#) SPSS DATA FILE - ";
