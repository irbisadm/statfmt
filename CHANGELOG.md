# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-07-14

Initial release. A TypeScript port of
[ReadStat](https://github.com/WizardMac/ReadStat) with no native dependencies.

### Added

- **SPSS**: read & write `.sav`, `.zsav` (zlib block compression), and `.por`
  (portable, base-30 encoding).
- **Stata**: read `.dta` versions 104–119 (legacy and xml-ish headers, strls,
  tagged missing); write `.dta` (default v118).
- **SAS**: read & write `.sas7bdat` (32/64-bit, RLE & RDC compression),
  `.sas7bcat` value-label catalogs, and `.xpt` transport files (v5/v8, IBM float).
- **Plain text with an external schema** via `readTxt()`: Stata dictionary
  (`.dct`), SPSS commands (`.sps`), and SAS commands (`.sas`).
- High-level API (`readSav`/`writeSav`/`readData`/`writeData`/`detectFormat`/
  `readTxt`, `Dataset`) over the low-level streaming parser/writer API that
  mirrors ReadStat's callback architecture.
- End-to-end test suite that cross-validates every format against the reference
  ReadStat C CLI (generation, reading, and structural round-trip).

[Unreleased]: https://github.com/irbisadm/readstat-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/irbisadm/readstat-ts/releases/tag/v0.1.0
