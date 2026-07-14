# @irbisadm/readstat-ts

[![npm](https://img.shields.io/npm/v/@irbisadm/readstat-ts.svg)](https://www.npmjs.com/package/@irbisadm/readstat-ts)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![types](https://img.shields.io/badge/types-TypeScript-blue.svg)](#)

Read and write statistical data files from **SPSS**, **Stata**, and **SAS** in
pure TypeScript — no native addons, no WASM, no system libraries.

> **This is a TypeScript port of [ReadStat](https://github.com/WizardMac/ReadStat)**
> (© 2013–2016 Evan Miller and ReadStat contributors, MIT licensed).
> It is a derivative work that faithfully re-implements ReadStat's readers,
> writers and binary-format logic in TypeScript. All credit for the original
> design and the hard reverse-engineering of these proprietary formats belongs
> to the ReadStat authors. See [Relationship to ReadStat](#relationship-to-readstat).

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

Plain-text data with an external schema can also be read via `readTxt()`:
**Stata dictionary** (`.dct`), **SPSS command** (`.sps` — `DATA LIST` /
`VALUE LABELS` / `VARIABLE LABELS`), and **SAS command** (`.sas` — `INPUT` /
`INFILE` / `LABEL` / `FORMAT` / `VALUE`) files.

See [Known limitations](#known-limitations) for the (intentional) gaps inherited
from ReadStat.

## Install

```bash
npm install @irbisadm/readstat-ts
```

**ESM-only**, requires **Node 18+** (uses the built-in `TextDecoder` for
character-set decoding and `node:zlib` for `.zsav`). The non-zlib formats work in
the browser too; supply a custom `Codec` / zlib shim for the rest.

## High-level API

### Reading

```ts
import { readFile } from "node:fs/promises";
import { readSav, readDta, readData, detectFormat } from "@irbisadm/readstat-ts";

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
import { writeSav, writeDta, ReadStatType, ReadStatMeasure } from "@irbisadm/readstat-ts";

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
import { ReadStatParser, BufferIoContext, parseSav } from "@irbisadm/readstat-ts";

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

### Plain-text with a schema

```ts
import { readTxt } from "@irbisadm/readstat-ts";

const data = new Uint8Array(await readFile("data.txt"));
const schema = new Uint8Array(await readFile("layout.dct"));
const ds = readTxt(data, schema, "stata"); // "stata" | "spss" | "sas"
```

## Character encodings

Decoding uses the platform `TextDecoder`, which covers the encodings SPSS/SAS/Stata
files declare (Windows-125x, ISO-8859-x, Shift-JIS, GBK, Big5, KOI8, …). For
writing to a non-UTF-8 target encoding, inject a custom `Codec` (e.g. backed by
`iconv-lite`).

## Testing & validation approach

Correctness for binary format work is meaningless unless it is checked against
the canonical implementation. This port is validated **against the real ReadStat
C library in both directions, for every format**, so "it round-trips through
itself" is never the whole story.

### Layers

1. **Unit tests** — per-format encoders/decoders and the shared core
   (RLE/RDC compression, IEEE↔IBM float conversion, POR base-30 numbers,
   endianness, timestamps, value/variable modelling). These run with **no
   external dependencies**:

   ```bash
   npm test
   ```

2. **End-to-end cross-validation against reference ReadStat.** The suite builds
   the actual ReadStat C CLI and drives it as a golden oracle. Three
   complementary directions:

   | Suite | Direction | What it proves |
   | --- | --- | --- |
   | `test/e2e/write.e2e.test.ts` | **generation** — TS writes → C reads | every file we emit is valid per ReadStat: exact variable names, values (numeric & string), system-missing, column count and file label are recovered by the C CLI |
   | `test/e2e/read.e2e.test.ts` | **reading** — C writes → TS reads | genuine files produced by ReadStat (each format transcoded from a validated base) are parsed to the exact same values, plus value labels where the format stores them |
   | `test/e2e/roundtrip.e2e.test.ts` | **structure** — TS → C → TS | variable labels, value labels and user-defined missing ranges — things the CLI's CSV/metadata dump can't surface — survive a full round-trip through the C library |

   Together these cover the two things a port must guarantee: what we **write** is
   readable by the reference, and what the reference **writes** is readable by us.

### Running the e2e layer

The reference CLI is built automatically on first `vitest` run (pinned to
**ReadStat v1.1.9**) into `.reference/` — this needs a C compiler, `make`, zlib
and iconv. You can also build it explicitly or point at an existing binary:

```bash
npm run build:reference                 # download/clone + build into .reference/
npm run test:e2e                        # run only the e2e layer
READSTAT_BIN=/path/to/readstat npm test # reuse an existing ReadStat build
READSTAT_NO_AUTOBUILD=1 npm test        # skip the auto-build (e2e tests then fail fast)
```

The build script prefers the pinned release tarball (which ships a generated
`./configure`, so no autotools are needed) and falls back to `git clone` +
`autogen`. If the reference cannot be built, the e2e tests fail with actionable
guidance rather than silently passing.

### Why go this far

The binary formats here are proprietary and reverse-engineered. A self-consistent
round-trip (write then read with the same code) can hide a shared bug on both
sides. Pinning every format to an independent, widely-used reference implementation
is what makes "compatible with SPSS/Stata/SAS tooling" a claim backed by tests
rather than hope.

## Relationship to ReadStat

`@irbisadm/readstat-ts` is a **port**, not an original work. It re-implements
[ReadStat](https://github.com/WizardMac/ReadStat) in TypeScript:

- the streaming, callback-based parser/writer architecture mirrors ReadStat's
  (`readstat_parser_t` → `ReadStatParser`, `readstat_writer_t` → `Writer`);
- the readers, writers and binary-layout logic for every format are ported from
  the corresponding ReadStat C sources;
- hand-written grammars replace the Ragel-generated C for the format/number/schema
  parsers.

All of the original insight — decoding SPSS/Stata/SAS binary layouts, the SAS RLE
and RDC schemes, the XPORT IBM float format, the POR encoding — is the work of
**Evan Miller and the ReadStat contributors**. This project stands entirely on
that work and preserves ReadStat's MIT copyright notice (see [LICENSE](./LICENSE)).

Please **support and cite the upstream project**:
<https://github.com/WizardMac/ReadStat>.

## Known limitations

These are inherited by design from ReadStat and are not bugs in the port:

- **Generated `.sas7bdat` files may not open in SAS itself.** The format is
  proprietary and undocumented; ReadStat (and therefore this port) produces files
  that ReadStat and compatible readers accept, but not every byte SAS's strict
  loader expects is known. Reading real SAS files works; producing files SAS will
  open is an open reverse-engineering problem upstream.
- **`.sas7bdat` value labels live in a separate `.sas7bcat` catalog**, not the
  data file — a standalone `.sas7bdat` legitimately carries none.
- **Text metadata formats are read-only.** `.dct` / `.sps` / `.sas` command and
  dictionary files are import schemas; there is no writer for them (there is
  nothing to serialize back). The binary `.sas7bcat` catalog *is* writable.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
Any change to a format must keep the end-to-end suite green (`npm run test:e2e`).
Improvements to binary-format fidelity that also benefit upstream should be
offered to [ReadStat](https://github.com/WizardMac/ReadStat) as well.

## License

[MIT](./LICENSE) © 2026 irbisadm.

Derivative work of [ReadStat](https://github.com/WizardMac/ReadStat),
© 2013–2016 Evan Miller and ReadStat contributors (MIT). ReadStat's original
copyright and permission notice are reproduced in [LICENSE](./LICENSE) as required.
