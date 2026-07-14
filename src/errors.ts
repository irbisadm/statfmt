//
// errors.ts — Error codes and messages (port of readstat_error.c)
//

export enum ReadStatError {
  OK = 0,
  ERROR_OPEN = 1,
  ERROR_READ = 2,
  ERROR_MALLOC = 3,
  ERROR_USER_ABORT = 4,
  ERROR_PARSE = 5,
  ERROR_UNSUPPORTED_COMPRESSION = 6,
  ERROR_UNSUPPORTED_CHARSET = 7,
  ERROR_COLUMN_COUNT_MISMATCH = 8,
  ERROR_ROW_COUNT_MISMATCH = 9,
  ERROR_ROW_WIDTH_MISMATCH = 10,
  ERROR_BAD_FORMAT_STRING = 11,
  ERROR_VALUE_TYPE_MISMATCH = 12,
  ERROR_WRITE = 13,
  ERROR_WRITER_NOT_INITIALIZED = 14,
  ERROR_SEEK = 15,
  ERROR_CONVERT = 16,
  ERROR_CONVERT_BAD_STRING = 17,
  ERROR_CONVERT_SHORT_STRING = 18,
  ERROR_CONVERT_LONG_STRING = 19,
  ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE = 20,
  ERROR_TAGGED_VALUE_IS_OUT_OF_RANGE = 21,
  ERROR_STRING_VALUE_IS_TOO_LONG = 22,
  ERROR_TAGGED_VALUES_NOT_SUPPORTED = 23,
  ERROR_UNSUPPORTED_FILE_FORMAT_VERSION = 24,
  ERROR_NAME_BEGINS_WITH_ILLEGAL_CHARACTER = 25,
  ERROR_NAME_CONTAINS_ILLEGAL_CHARACTER = 26,
  ERROR_NAME_IS_RESERVED_WORD = 27,
  ERROR_NAME_IS_TOO_LONG = 28,
  ERROR_BAD_TIMESTAMP_STRING = 29,
  ERROR_BAD_FREQUENCY_WEIGHT = 30,
  ERROR_TOO_MANY_MISSING_VALUE_DEFINITIONS = 31,
  ERROR_NOTE_IS_TOO_LONG = 32,
  ERROR_STRING_REFS_NOT_SUPPORTED = 33,
  ERROR_STRING_REF_IS_REQUIRED = 34,
  ERROR_ROW_IS_TOO_WIDE_FOR_PAGE = 35,
  ERROR_TOO_FEW_COLUMNS = 36,
  ERROR_TOO_MANY_COLUMNS = 37,
  ERROR_NAME_IS_ZERO_LENGTH = 38,
  ERROR_BAD_TIMESTAMP_VALUE = 39,
  ERROR_BAD_MR_STRING = 40,
}

const MESSAGES: Partial<Record<ReadStatError, string>> = {
  [ReadStatError.ERROR_OPEN]: "Unable to open file",
  [ReadStatError.ERROR_READ]: "Unable to read from file",
  [ReadStatError.ERROR_MALLOC]: "Unable to allocate memory",
  [ReadStatError.ERROR_USER_ABORT]: "The parsing was aborted (callback returned non-zero value)",
  [ReadStatError.ERROR_PARSE]: "Invalid file, or file has unsupported features",
  [ReadStatError.ERROR_UNSUPPORTED_COMPRESSION]: "File has unsupported compression scheme",
  [ReadStatError.ERROR_UNSUPPORTED_CHARSET]: "File has an unsupported character set",
  [ReadStatError.ERROR_COLUMN_COUNT_MISMATCH]: "File did not contain the expected number of columns",
  [ReadStatError.ERROR_ROW_COUNT_MISMATCH]: "File did not contain the expected number of rows",
  [ReadStatError.ERROR_ROW_WIDTH_MISMATCH]: "A row in the file was not the expected length",
  [ReadStatError.ERROR_BAD_FORMAT_STRING]: "A provided format string could not be understood",
  [ReadStatError.ERROR_VALUE_TYPE_MISMATCH]: "A provided value was incompatible with the variable's declared type",
  [ReadStatError.ERROR_WRITE]: "Unable to write data",
  [ReadStatError.ERROR_WRITER_NOT_INITIALIZED]:
    "The writer object was not properly initialized (call and check return value of readstat_begin_writing_XXX)",
  [ReadStatError.ERROR_SEEK]: "Unable to seek within file",
  [ReadStatError.ERROR_CONVERT]: "Unable to convert string to the requested encoding",
  [ReadStatError.ERROR_CONVERT_BAD_STRING]:
    "Unable to convert string to the requested encoding (invalid byte sequence)",
  [ReadStatError.ERROR_CONVERT_SHORT_STRING]:
    "Unable to convert string to the requested encoding (incomplete byte sequence)",
  [ReadStatError.ERROR_CONVERT_LONG_STRING]:
    "Unable to convert string to the requested encoding (output buffer too small)",
  [ReadStatError.ERROR_NUMERIC_VALUE_IS_OUT_OF_RANGE]:
    "A provided numeric value was outside the range of representable values in the specified file format",
  [ReadStatError.ERROR_TAGGED_VALUE_IS_OUT_OF_RANGE]:
    "A provided tag value was outside the range of allowed values in the specified file format",
  [ReadStatError.ERROR_STRING_VALUE_IS_TOO_LONG]:
    "A provided string value was longer than the available storage size of the specified column",
  [ReadStatError.ERROR_TAGGED_VALUES_NOT_SUPPORTED]:
    "The file format does not supported character tags for missing values",
  [ReadStatError.ERROR_UNSUPPORTED_FILE_FORMAT_VERSION]: "This version of the file format is not supported",
  [ReadStatError.ERROR_NAME_BEGINS_WITH_ILLEGAL_CHARACTER]: "A provided name begins with an illegal character",
  [ReadStatError.ERROR_NAME_CONTAINS_ILLEGAL_CHARACTER]: "A provided name contains an illegal character",
  [ReadStatError.ERROR_NAME_IS_RESERVED_WORD]: "A provided name is a reserved word",
  [ReadStatError.ERROR_NAME_IS_TOO_LONG]: "A provided name is too long for the file format",
  [ReadStatError.ERROR_NAME_IS_ZERO_LENGTH]: "A provided name is blank or empty",
  [ReadStatError.ERROR_BAD_TIMESTAMP_STRING]: "The file's timestamp string is invalid",
  [ReadStatError.ERROR_BAD_FREQUENCY_WEIGHT]: "The provided variable can't be used as a frequency weight",
  [ReadStatError.ERROR_TOO_MANY_MISSING_VALUE_DEFINITIONS]:
    "The number of defined missing values exceeds the format limit",
  [ReadStatError.ERROR_NOTE_IS_TOO_LONG]: "The provided note is too long for the file format",
  [ReadStatError.ERROR_STRING_REFS_NOT_SUPPORTED]: "This version of the file format does not support string references",
  [ReadStatError.ERROR_STRING_REF_IS_REQUIRED]: "The provided value was not a valid string reference",
  [ReadStatError.ERROR_ROW_IS_TOO_WIDE_FOR_PAGE]: "A row of data will not fit into the file format",
  [ReadStatError.ERROR_TOO_FEW_COLUMNS]: "One or more columns must be provided",
  [ReadStatError.ERROR_TOO_MANY_COLUMNS]: "Too many columns for this file format version",
  [ReadStatError.ERROR_BAD_TIMESTAMP_VALUE]: "The provided file timestamp is invalid",
  [ReadStatError.ERROR_BAD_MR_STRING]: "A multi-response set record is invalid",
};

export function readstatErrorMessage(code: ReadStatError): string | null {
  if (code === ReadStatError.OK) return null;
  return MESSAGES[code] ?? "Unknown error";
}

/** Exception thrown to unwind out of the parsing/writing loop, carrying an error code. */
export class ReadStatException extends Error {
  code: ReadStatError;
  constructor(code: ReadStatError, message?: string) {
    super(message ?? readstatErrorMessage(code) ?? `ReadStat error ${code}`);
    this.name = "ReadStatException";
    this.code = code;
  }
}

/** Throw when `code` is not OK. */
export function check(code: ReadStatError): void {
  if (code !== ReadStatError.OK) {
    throw new ReadStatException(code);
  }
}
