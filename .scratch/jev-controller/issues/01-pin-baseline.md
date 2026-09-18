# 01: Pin upstream baseline and record pre-change suite

**What to build:** A reproducible starting point: the fork records exactly which upstream it diverges from, and saves the untouched test result everything later must preserve.

**Blocked by:** None (can start immediately).

**Status:** done

**Plan source:** AGENT_HANDOFF.md §4, §13 (M0), §14.

- [x] Upstream HEAD resolved to an immutable SHA and recorded with fork SHA, package version, Node version, Pi version, and lockfile hash in `docs/upstream-baseline.json`
- [x] Upstream license and attribution preserved; work happens in a fork and an isolated worktree
- [x] Dependencies installed per the checked-in package-manager configuration; existing suite run before any change and its result saved
- [x] Extension entry, JSONL helpers, path helpers, compaction, and setup skill inspected and understood
- [x] Coding-agent checkout kept separate from the target repository under optimization (no overlapping tool/command names loaded together)

## Comments

- 2026-09-18: upstream HEAD resolved live (`git ls-remote` → `939ede8`), fork `59672d3`, suite 66 pass / 0 fail saved in `docs/upstream-baseline.json`. No isolated worktree yet — required from ticket 04 onward (noted in baseline file).
