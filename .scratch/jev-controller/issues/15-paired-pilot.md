# 15: Paired three-arm pilot and frozen comparison

**What to build:** The evidence itself: a fair end-to-end contest between upstream behavior, the structured workflow with an LLM selector, and the structured workflow with Jev.

**Blocked by:** 12 (Five-attempt live smoke), 14 (Outcome-labeled snapshot set).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §11.3, §11.4, §11.5, §13 (M3).

- [ ] Three inexpensive task families (one close to real intended use) run at three trials per arm with ten post-baseline slots each, on frozen prompts, policies, revisions, seeds, environments, and budgets; held-out tasks kept separate from tuning tasks
- [ ] Arms isolated (fresh worktree, conversation, caches, no shared notes); paired trials share the frozen domain question plan with consistent cost charging; noisy benchmarks never run concurrently on shared hardware
- [ ] Primary budget basis (money or wall-clock) and smallest useful effect predeclared before confirmatory outcomes are inspected; no sampling until a favorable result appears
- [ ] Paired complete-hybrid-vs-upstream and Jev-vs-structured-LLM differences reported per task with costs and uncertainty; final artifacts revalidated by randomized repeated measurement against the baseline with a predeclared fallback
- [ ] Deliverable is evidence including failures and null results, never a predetermined Jev win
