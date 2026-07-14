# readstat-ts

A TypeScript port of [ReadStat](https://github.com/WizardMac/ReadStat) — read and
write statistical data files from **SPSS**, **Stata**, and **SAS** with no native
dependencies.

The port mirrors ReadStat's streaming, callback-based architecture and is
validated against the reference C implementation (files written by this library
are read back correctly by ReadStat, and files produced by ReadStat are read
correctly here).

## Format support

| Format | Extension | Read | Write |
| --- | --- | :---: | :---: |
| SPSS | `.sav` | ✅ | ✅ |
| SPSS compressed | `.zsav` | ✅ | ✅ |
| SPSS portable | `.por` | ✅ | ✅ |
| Stata | `.dta` (v104–119) | ✅ | ✅ |
| SAS database | `.sas7bdat` | ✅ | ✅ |
| SAS catalog | `.sas7bcat` | ✅ | ✅ |
| SAS transport | `.xpt` (v5/v8) | ✅ | ✅ |

✅ ported & tested · 🚧 in progress

## Install

```bash
npm install readstat-ts
```

Requires Node 18+ (uses the built-in `TextDecoder` for character-set decoding and
`node:zlib` for `.zsav`). Works in the browser for the non-zlib formats; supply a
custom `Codec`/zlib shim otherwise.

## High-level API

### Reading

```ts
import { readFile } from "node:fs/promises";
import { readSav, readDta, readData, detectFormat } from "readstat-ts";

const bytes = new Uint8Array(await readFile("survey.sav"));
const ds = readSav(bytes);

ds.metadata.rowCount;          // number of rows (-1 if unknown)
ds.variables[0].name;          // "id"
ds.variables[2].valueLabels;   // [{ value: 1, label: "Male" }, ...]
ds.rows[0];                    // [1, 3.5, 1, "Alice"]
ds.toObjects();                // [{ id: 1, score: 3.5, ... }, ...]

// auto-detect from magic bytes
const fmt = detectFormat(bytes); // "sav" | "zsav" | "dta" | ...
const ds2 = readData(fmt!, bytes);
```

`ReadOptions` let you override the encoding or window the rows:

```ts
readDta(bytes, { inputEncoding: "WINDOWS-1251", rowLimit: 100, rowOffset: 0 });
```

### Writing

```ts
import { writeSav, writeDta, ReadStatType, ReadStatMeasure } from "readstat-ts";

const bytes = writeSav({
  fileLabel: "My dataset",
  valueLabelSets: {
    sex: [{ value: 1, label: "Male" }, { value: 2, label: "Female" }],
  },
  variables: [
    { name: "id",    type: ReadStatType.INT32,  measure: ReadStatMeasure.SCALE },
    { name: "score", type: ReadStatType.DOUBLE, label: "Test score" },
    { name: "sex",   type: ReadStatType.INT32,  valueLabels: "sex" },
    { name: "name",  type: ReadStatType.STRING, storageWidth: 40 },
  ],
  rows: [
    [1, 3.5, 1, "Alice"],
    [2, 9.25, 2, "Bob"],
    [3, null, 1, "Carol"],   // null => missing
  ],
});

// await writeFile("out.sav", bytes);
```

`writeZsav(spec)` produces a zlib-compressed `.sav`; `writeDta(spec)` writes Stata
`.dta` (default version 118 — pass `version: 117` etc. to target older Stata).

## Low-level streaming API

The high-level helpers are built on the same callback API as C ReadStat, exposed
for when you want to stream millions of rows without materializing them:

```ts
import { ReadStatParser, BufferIoContext, parseSav } from "readstat-ts";

const parser = new ReadStatParser();
parser.setMetadataHandler((md) => console.log(md.rowCount, md.varCount));
parser.setVariableHandler((index, variable, valLabels) => { /* ... */ });
parser.setValueHandler((obsIndex, variable, value) => {
  console.log(obsIndex, variable.getName(), value.toJS());
});
parseSav(parser, new BufferIoContext(bytes), null);
```

The `Writer` class exposes the incremental writer API
(`addVariable`, `beginRow`, `insertDoubleValue`, `endRow`, …).

## Character encodings

Decoding uses the platform `TextDecoder`, which covers the encodings SPSS/SAS/Stata
files declare (Windows-125x, ISO-8859-x, Shift-JIS, GBK, Big5, KOI8, …). For
writing to a non-UTF-8 target encoding, inject a custom `Codec` (e.g. backed by
`iconv-lite`) via `parser.setCodec(...)`.

## License

MIT. Port of ReadStat, © Evan Miller and ReadStat authors.
