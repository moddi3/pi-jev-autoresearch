# 01: Restore honest development baseline (CI predicate + fork install)

**What to build:** A CI gate that can actually pass on the checked-in tree and a quick start that installs this fork, so every later ticket builds on verified green rather than a red baseline.

**Blocked by:** None (can start immediately).

**Status:** done

**Plan source:** review-2026-09-18 §R9, §R10, PR 0.

- [x] CI generated-output predicate allows tracked source docs while still rejecting real build output
- [x] CI runs on the relevant main pushes and retains pull-request checks
- [x] Full workflow actually run end to end (including the site build), not only the unit-test command; output recorded
- [x] Quick start installs this fork via a verified revision-pinned path or local extension load, never the upstream package
- [x] Package metadata identifies the fork (distinct name if published; correct repository/homepage/issues); upstream copyright and license attribution preserved
- [x] Install doc covers dependency installation, API-key setup, Jev opt-in, and a five-experiment smoke session
- [x] New fork SHA, runtime/package-manager versions, installed dependency versions, and actual test output recorded; historical baseline data not overwritten with claims never rerun
- [x] Clean pinned upstream checkout kept for differential checks
- [x] Regression: `ci-generated-paths` — source docs tracked, build output untracked, CI predicate allows authored docs
- [x] Install doc warns against loading upstream and fork simultaneously (shared commands/tools) and states synthetic eval reports are not live comparisons

## Comments

Done 2026-09-18. Code commit `8bd305c` (CI, `tests/ci-generated-paths.test.mjs`,
`package.json`/`package-lock.json`, README); record commit (this ticket file +
`docs/fork-baseline.json`, see below).
- TDD: new `ci-generated-paths` test failed red on the old tree (bad predicate +
  `branches-ignore: [main]`), green after the fix (3/3).
- Full workflow on the committed tree: `pnpm install`, `pnpm test`
  (353 tests / 352 pass / 0 fail / 1 skipped — skip is the live TypeSafe SDK call,
  no `TYPESAFE_API_KEY`), `pnpm --dir site install/build`, build files verified,
  `test -z "$(git ls-files site/build)"` passes. Details in `docs/fork-baseline.json`.
- `docs/upstream-baseline.json` untouched; new record is `docs/fork-baseline.json`.
- Clean upstream checkout at `/Users/moddi3/projects/pi-autoresearch-upstream`
  @ `939ede8` (matches baseline upstream SHA), `git status` clean.
- Deviation: `package.json` sets `"private": true` — the fork is not published to
  npm, so install is via pinned Git revision or local load only. The distinct
  `pi-jev-autoresearch` name is reserved for a future separate publish.
- Deviation: two commits under the `01-honest-baseline:` prefix (code, then this
  record) so the baseline file can name the tested tree SHA honestly instead of
  self-referencing its own commit.
