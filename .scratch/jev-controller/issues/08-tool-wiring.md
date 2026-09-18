# 08: Selection tools and proposal protocol wiring

**What to build:** The extension wiring that makes propose → select → implement the only path to target edits in Jev mode, while leaving every other mode untouched.

**Blocked by:** 07 (Jev selector with strict validation and pause-on-failure).

**Status:** ready-for-agent

**Plan source:** AGENT_HANDOFF.md §5 (existing-file changes), §6.1, §7.

- [ ] Selection tools registered through the existing gated registration helper, active only when autoresearch and Jev control are both enabled
- [ ] Session-start guidance adds the proposal → select → implement protocol only in Jev mode; baseline establishment stays exempt from selection and post-baseline runs are clearly distinguished from verification repeats
- [ ] Documented preflight blocks target writes/edits without a pending decision and rejects conflicting simultaneous selection/run operations in Jev mode
- [ ] LLM implements only the selected experiment within approved scope (necessary mechanical changes permitted); implementing all candidates or substituting a preferred alternative is rejected
- [ ] Off-mode regression: original experience unchanged, and enabling/disabling the controller never deactivates unrelated tools
