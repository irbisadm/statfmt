# Contributing

Thanks for your interest in `@irbisadm/readstat-ts`. This project is a
TypeScript **port** of [ReadStat](https://github.com/WizardMac/ReadStat); please
keep that framing in mind — changes should stay faithful to the upstream
behavior unless there is a clear, documented reason to diverge.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # full suite (auto-builds the reference C CLI on first run)
npm run build         # emit dist/
```

The end-to-end suite drives the real ReadStat C CLI as a golden oracle. It is
built automatically on the first `vitest` run into `.reference/` and needs a C
compiler, `make`, zlib and iconv. See the
[Testing & validation approach](./README.md#testing--validation-approach)
section for details and the relevant environment variables
(`READSTAT_BIN`, `READSTAT_NO_AUTOBUILD`).

## Ground rules

- **Keep the e2e suite green.** Any change to a reader or writer must still pass
  `npm run test:e2e` — what we write must be readable by reference ReadStat, and
  what reference ReadStat writes must be readable by us.
- **Add tests with behavior.** New format coverage or bug fixes should come with
  a unit test and, where a format is involved, an e2e assertion.
- **Match the surrounding style.** ESM with explicit `.js` import specifiers,
  `strict` TypeScript, no new runtime dependencies without discussion.
- **Document intentional deviations from ReadStat** in code comments, so they are
  not later "fixed" back into a bug.

## Attribution

Substantial portions of this codebase are derived from ReadStat. If your change
also improves binary-format fidelity, consider offering it upstream to
[ReadStat](https://github.com/WizardMac/ReadStat) as well. By contributing you
agree that your contributions are licensed under the project's
[MIT license](./LICENSE).
