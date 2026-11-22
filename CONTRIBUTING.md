# Contributing to Zyrix

## Setup

```bash
npm ci            # Node >= 20.19, lockfile is authoritative
npm test          # 243 tests at the time of writing
npm run lint
npm run typecheck
npm run types:check
npm run test:coverage
```

`types:check` fails when a public `.d.ts` signature changes without regenerating
`types-surface.json` (`npm run types:surface`) or when declarations and runtime exports
diverge. Do not edit `types-surface.json` by hand to make CI pass; regenerate it and explain
the public change in the pull request.

## What a pull request must include

- **A regression test for every behaviour change or bug fix.** Tests are the contract:
  a fix without a test that failed before it is not finished.
- **No hidden failures.** Do not add `catch {}` around a failure you cannot explain, do not
  skip a test to get green, and do not weaken an assertion. If something cannot be verified
  without a real WhatsApp account, write `PENDIENTE: requiere WhatsApp real` next to it.
- **No silent policy changes.** Security defaults (`trustPolicy`, size limits, URL
  validation, key handling) change only with a documented rationale and a migration note.
- **No unrequested dependencies.** Runtime dependencies stay minimal; prove that the code
  cannot live in the repository and update `THIRD_PARTY_NOTICES.md` when adding one.
- **Green checks:** `lint`, `typecheck`, `types:check`, `test` and `test:coverage`. The
  coverage job enforces at least 90% of lines across `src/`; keep it there.

## Review rules

| Change | Reviewers |
| --- | --- |
| Docs, tests, comments | 1 |
| Public API or behaviour | 1, plus a note in the README/upgrade notes |
| Crypto, session format, identity/trust policy | **2**, one of them focused on the threat model in [SECURITY.md](SECURITY.md) |
| Release (version bump + tag) | 1 maintainer and a second person checking the package contents |

A reviewer must be able to reproduce the reported behaviour locally. "Works on my machine"
without a command and its output is not a review.

## Bus factor

The project currently has a single maintainer. To keep it recoverable:

- Everything needed to build, test, review and release is in this repository and in
  [SECURITY.md](SECURITY.md) / [REAL-WORLD-TESTING.md](REAL-WORLD-TESTING.md); no private
  runbooks.
- Releases are reproducible from a clean clone with `npm ci` and the commands above.
- Crypto and session-format changes require a second reviewer precisely because the
  maintainer may be unavailable.
- Session encryption keys are never stored in the repository, in tests or in CI. Rotate any
  key that is ever exposed.
- If you depend on Zyrix in production, consider funding a second maintainer or a
  cryptographic review; that is the most effective way to reduce this risk.

## Release process

1. `npm version <minor|patch>` (never rewrite a published version).
2. `npm test`, `npm run lint`, `npm run typecheck`, `npm run types:check`,
   `npm run test:coverage`, `npm audit --omit=dev`, `npm pack --dry-run`.
3. Confirm the tarball has no `tests/`, `type-tests/` or `scripts/` files.
4. Update the upgrade notes in `README.md` and `README.es.md` when behaviour changed.
5. Tag `vX.Y.Z` and publish. Record any real-device results from
   [REAL-WORLD-TESTING.md](REAL-WORLD-TESTING.md) with a date; do not claim results that
   were not run.

## Commit style

Short imperative subject in the area that changed, for example
`fix(media): publish without hardlinks`. Explain *why* in the body, list the checks you
ran, and keep unrelated refactors out of the same commit.
