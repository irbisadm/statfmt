# Changelog

This file is generated automatically from [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release) on every release from `main`.

## [0.1.1](https://github.com/irbisadm/statfmt/compare/v0.1.0...v0.1.1) (2026-07-14)


### Bug Fixes

* correct project author to Igor Sheko ([71e42d3](https://github.com/irbisadm/statfmt/commit/71e42d393e28213cd392bb20ef38bb6f9449fc68))

## 0.1.0 (2026-07-14)

Initial release — a TypeScript port of [ReadStat](https://github.com/WizardMac/ReadStat) with no native dependencies.

### Features

* **spss:** read & write `.sav`, `.zsav` (zlib block compression) and `.por` (portable)
* **stata:** read `.dta` v104–119 (legacy + xml-ish headers, strls, tagged missing); write `.dta` (default v118)
* **sas:** read & write `.sas7bdat` (32/64-bit, RLE & RDC), `.sas7bcat` value-label catalogs and `.xpt` transport (v5/v8, IBM float)
* **txt:** read plain-text data via Stata dictionary (`.dct`), SPSS command (`.sps`) and SAS command (`.sas`) schemas
* **api:** high-level `readSav`/`writeSav`/`readData`/`writeData`/`detectFormat`/`readTxt` over a streaming, callback-based parser/writer that mirrors ReadStat
* **e2e:** cross-validated against the reference ReadStat C library in both directions for every format
