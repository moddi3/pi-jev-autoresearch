# Spec: Remediation of implementation review 2026-09-18

**Plan source:** `.scratch/remediation/review-2026-09-18.md` at the reviewed revision `44d2e1c` (implementation review and remediation handoff). It is the authoritative spec; this file is a routing pointer, not a duplicate.

**Feature slug:** `remediation`

**Summary:** Fix runtime invariants first (R1–R6), then demonstrate one live end-to-end trajectory, then implement the actual comparison (R7–R8), with release hygiene underneath (R9–R10). No rewrite, no new reasoning strategies, no expectimax/dashboards until the existing design is trustworthy.

**Tickets:** `.scratch/remediation/issues/01..07`, numbered in dependency order (blockers first). Frontier: any ticket whose blockers are all done.
