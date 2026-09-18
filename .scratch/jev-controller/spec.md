# Spec: Jev-directed pi-autoresearch controller

**Plan source:** `AGENT_HANDOFF.md` at the repo root (implementation specification, 2026-09-18). It is the authoritative spec; this file is a routing pointer, not a duplicate.

**Feature slug:** `jev-controller`

**Summary:** Small opt-in fork of `pi-autoresearch`. Pi's LLM proposes concrete experiments; Jev selects the next one from a bounded set; the existing runner measures, checks correctness, logs, and keeps or reverts. Default mode unchanged.

**Milestones (from plan §13):** M0 baseline + adapter → M1 functioning V1 → M2 measurement infrastructure → M3 pilot + frozen comparison → M4 ablations only after evidence.

**Tickets:** `.scratch/jev-controller/issues/01..16`, numbered in dependency order. Frontier: any ticket whose blockers are all done.
