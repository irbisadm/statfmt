# Contributing

Thanks for your interest in `@irbisadm/statfmt`. This project is a
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

## Commit convention

This project uses [**Conventional Commits**](https://www.conventionalcommits.org/).
This is not just style: **releases are fully automated from the commit messages**
by [semantic-release](https://github.com/semantic-release/semantic-release). On
every push to `main`, the next version number, the git tag, the GitHub release
and the `CHANGELOG.md` entry are all derived from the commits. Malformed messages
break that pipeline, so commit messages are linted with commitlint in CI.

Format:

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

Types and their effect on a release:

| Type | Changelog section | Version bump |
| --- | --- | --- |
| `feat` | Features | minor |
| `fix` | Bug Fixes | patch |
| `perf` | Performance Improvements | patch |
| `docs`, `test`, `refactor`, `build`, `ci`, `chore`, `style` | — | none |

A **breaking change** bumps the major version: add `!` after the type/scope
(`feat(sav)!: …`) or a `BREAKING CHANGE:` footer.

Scopes track the area of the port: `core`, `sav`, `zsav`, `por`, `dta`, `sas`,
`txt`, `api`, `e2e`, `ci`, `release`.

Keep the **description** short and imperative; put detail (e.g. "validated against
the reference C library") in the body.

Examples:

```
feat(dta): support Stata 14 business calendars
fix(sav): handle zero-length string variables
docs: clarify encoding options in the README

feat(api)!: rename readPor `inputEncoding` option to `encoding`

BREAKING CHANGE: `inputEncoding` is now `encoding` across all readers.
```

## Releasing (maintainers)

Releases are cut automatically by [semantic-release](https://github.com/semantic-release/semantic-release)
on every push to `main` (`.github/workflows/release.yml`). Publishing to npm uses
**[Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers)**, so no
long-lived npm token lives in the repo and each release gets a signed provenance
attestation. Requirements are already wired up: the workflow has
`permissions: id-token: write`, runs on Node 22 and upgrades to npm ≥ 11.5.1
(OIDC needs it).

One-time setup on npmjs.com — **Package settings → Trusted Publisher → GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `irbisadm` |
| Repository | `statfmt` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |
| Allowed actions | `npm publish` |

Because a trusted publisher can only be configured on a package that already
exists, **bootstrap the very first release** one of two ways:

1. **Temporary token** — add an `NPM_TOKEN` repository secret (an npm *Automation*
   token). The release workflow uses it only when present, so the first push to
   `main` publishes `0.1.0` and creates the package. Then configure the trusted
   publisher above and **delete the `NPM_TOKEN` secret** — subsequent releases use
   OIDC automatically.
2. **Manual publish** — `npm publish --access public` once locally to create the
   package, then configure the trusted publisher.

After bootstrap, no secrets beyond the automatic `GITHUB_TOKEN` are needed.

## Attribution

Substantial portions of this codebase are derived from ReadStat. If your change
also improves binary-format fidelity, consider offering it upstream to
[ReadStat](https://github.com/WizardMac/ReadStat) as well. By contributing you
agree that your contributions are licensed under the project's
[MIT license](./LICENSE).
