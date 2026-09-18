# 01: Pin upstream baseline and record pre-change suite

**What to build:** A reproducible starting point: the fork records exactly which upstream it diverges from, and saves the untouched test result everything later must preserve.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §4, §13 (M0), §14.

- [ ] Upstream HEAD resolved to an immutable SHA and recorded with fork SHA, package version, Node version, Pi version, and lockfile hash in `docs/upstream-baseline.json`
- [ ] Upstream license and attribution preserved; work happens in a fork and an isolated worktree
- [ ] Dependencies installed per the checked-in package-manager configuration; existing suite run before any change and its result saved
- [ ] Extension entry, JSONL helpers, path helpers, compaction, and setup skill inspected and understood
- [ ] Coding-agent checkout kept separate from the target repository under optimization (no overlapping tool/command names loaded together)
