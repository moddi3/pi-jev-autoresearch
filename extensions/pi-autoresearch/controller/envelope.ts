/**
 * Canonical runtime/replay selection envelope (remediation ticket 05,
 * review-2026-09-18 §R8 PR 4).
 *
 * One selection envelope shared by the live runtime and frozen replay, so a
 * replayed decision provably saw exactly what the live selector saw.
 *
 * The envelope contains the complete sanitized decision state, the compiled
 * instruction, the presented option ordering, the schema version, the policy
 * identity, and a semantic input hash. Provider-specific wrappers may differ
 * (the Jev arm sends full state; the structured-LLM arm sends an isolated
 * prompt), but the evidence and candidate information covered by the envelope
 * must match: both arms build it through {@link buildSelectionEnvelope}.
 *
 * Future outcomes travel separately (cached outcome records joined by stable
 * ID at metric time) and are never part of the envelope: nothing the selector
 * sees can carry a measured utility or outcome label.
 */

import {
  REQUEST_NEW_CANDIDATES,
  REQUEST_NEW_CANDIDATES_DESCRIPTION,
  buildCandidateOptions,
  compileSelectionInstruction,
  type SessionQuestionPolicy,
} from "./questions.ts";
import { sha256Hex, stableStringify } from "./store.ts";
import type { DecisionState } from "./types.ts";

/** Version of the canonical selection envelope. */
export const SELECTION_ENVELOPE_VERSION = 1 as const;

export class SelectionEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionEnvelopeError";
  }
}

/** Policy identity carried by the envelope: frozen version plus clause hash. */
export interface EnvelopePolicyIdentity {
  version: number;
  domainClauseHash: string;
}

/**
 * Canonical selection envelope: everything a selector decision is graded
 * against, in one hashable structure.
 */
export interface SelectionEnvelope {
  envelopeVersion: typeof SELECTION_ENVELOPE_VERSION;
  /** Decision-state schema version the envelope was built over. */
  schemaVersion: 1;
  /** Complete sanitized decision state (candidates, measured history, evidence, budget). */
  state: DecisionState;
  /** Extension-compiled selection instruction (protected purpose + frozen clause + evidence rules). */
  instruction: string;
  /** Presented options in recorded presentation order. */
  optionsInOrder: Array<{ id: string; description: string }>;
  /** Eligible candidate IDs (prefilter-derived, in derivation order). */
  eligibleIds: string[];
  /** Recorded presentation permutation: exactly [...eligibleIds, "request_new_candidates"] in order. */
  selectableOrder: string[];
  /** Frozen policy identity (version + domain-clause hash). */
  policy: EnvelopePolicyIdentity;
  /** Semantic input hash: sha256 over the normalized envelope content. */
  semanticInputHash: string;
}

export interface BuildSelectionEnvelopeInput {
  state: DecisionState;
  policy: SessionQuestionPolicy;
  eligibleIds: string[];
  selectableOrder: string[];
}

function envelopeError(message: string): never {
  throw new SelectionEnvelopeError(message);
}

/**
 * Build the canonical selection envelope from frozen inputs.
 *
 * The instruction and option descriptions are rebuilt here through the same
 * extension-owned builders the runtime uses, so the hash covers semantic
 * content (what the selector saw), not incidental serialization. Throws
 * `SelectionEnvelopeError` when the presentation order is not exactly the
 * eligible IDs plus the extension-owned no-good-option action.
 */
export function buildSelectionEnvelope(input: BuildSelectionEnvelopeInput): SelectionEnvelope {
  const { state, policy, eligibleIds, selectableOrder } = input;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    envelopeError("state must be a decision state object");
  }
  if ((state as DecisionState).schemaVersion !== 1) {
    envelopeError("state.schemaVersion must be 1");
  }
  const candidates = (state as DecisionState).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    envelopeError("state.candidates must hold at least one candidate");
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    envelopeError("policy must be the frozen session question policy");
  }
  if (typeof (policy as SessionQuestionPolicy).domainClauseHash !== "string" ||
      (policy as SessionQuestionPolicy).domainClauseHash.length === 0) {
    envelopeError("policy.domainClauseHash must be a non-empty string");
  }
  if (!Array.isArray(eligibleIds)) envelopeError("eligibleIds must be an array of candidate ids");
  const candidateIds = new Set(candidates.map((entry) => (entry as { id?: unknown }).id));
  for (const id of eligibleIds) {
    if (typeof id !== "string" || !candidateIds.has(id)) {
      envelopeError(`eligibleIds holds unknown candidate ${JSON.stringify(id)}`);
    }
  }
  if (!Array.isArray(selectableOrder)) {
    envelopeError("selectableOrder must be the recorded presentation permutation");
  }
  const expected = [...eligibleIds, REQUEST_NEW_CANDIDATES].sort();
  const actual = [...selectableOrder].sort();
  if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
    envelopeError(
      `selectableOrder must be exactly the eligible ids plus ${JSON.stringify(REQUEST_NEW_CANDIDATES)} ` +
        `in recorded order, got [${selectableOrder.join(", ")}]`,
    );
  }

  const instruction = compileSelectionInstruction(policy as SessionQuestionPolicy);
  const eligible = candidates.filter((entry) => eligibleIds.includes(entry.id));
  // A frozen empty mapping is a recorded result, not a dispatch: the envelope
  // still carries the no-good-option action so its hash stays comparable.
  const options: Record<string, string> = eligible.length === 0
    ? { [REQUEST_NEW_CANDIDATES]: REQUEST_NEW_CANDIDATES_DESCRIPTION }
    : buildCandidateOptions(eligible as Parameters<typeof buildCandidateOptions>[0]);
  const optionsInOrder = selectableOrder.map((id) => {
    const description = options[id];
    if (typeof description !== "string") {
      envelopeError(`recorded order references unknown option ${JSON.stringify(id)}`);
    }
    return { id, description: description as string };
  });

  const envelope: SelectionEnvelope = {
    envelopeVersion: SELECTION_ENVELOPE_VERSION,
    schemaVersion: 1,
    state: state as DecisionState,
    instruction,
    optionsInOrder,
    eligibleIds: [...eligibleIds],
    selectableOrder: [...selectableOrder],
    policy: {
      version: (policy as SessionQuestionPolicy).version,
      domainClauseHash: (policy as SessionQuestionPolicy).domainClauseHash,
    },
    semanticInputHash: "",
  };
  envelope.semanticInputHash = hashSelectionEnvelope(envelope);
  return envelope;
}

/** Normalized content hashed as the semantic input hash (excludes the hash itself). */
function envelopeContent(envelope: Omit<SelectionEnvelope, "semanticInputHash">): Record<string, unknown> {
  return {
    envelopeVersion: envelope.envelopeVersion,
    schemaVersion: envelope.schemaVersion,
    state: envelope.state,
    instruction: envelope.instruction,
    optionsInOrder: envelope.optionsInOrder,
    eligibleIds: envelope.eligibleIds,
    selectableOrder: envelope.selectableOrder,
    policy: envelope.policy,
  };
}

/** Hash the normalized envelope content (stable key order; array order is semantic). */
export function hashSelectionEnvelope(envelope: Omit<SelectionEnvelope, "semanticInputHash">): string {
  return sha256Hex(stableStringify(envelopeContent(envelope)));
}

/**
 * Verify that a selector input carrying envelope fields reproduces its
 * declared hash from those fields alone. This is the runtime/replay
 * equivalence check: recompute from what the selector provably saw.
 */
export function verifySelectionEnvelope(input: {
  state: unknown;
  instruction: unknown;
  optionsInOrder: unknown;
  eligibleIds: unknown;
  selectableOrder: unknown;
  policyHash?: unknown;
  domainClauseHash?: unknown;
  policyVersion?: unknown;
  envelopeVersion: unknown;
  envelopeHash: unknown;
}): boolean {
  if (input.envelopeVersion !== SELECTION_ENVELOPE_VERSION) return false;
  if (typeof input.envelopeHash !== "string" || input.envelopeHash.length === 0) return false;
  const policyHash =
    typeof input.policyHash === "string"
      ? input.policyHash
      : typeof input.domainClauseHash === "string"
        ? input.domainClauseHash
        : null;
  if (policyHash === null) return false;
  if (typeof input.instruction !== "string") return false;
  if (!Array.isArray(input.optionsInOrder) || !Array.isArray(input.eligibleIds) || !Array.isArray(input.selectableOrder)) {
    return false;
  }
  const recomputed = hashSelectionEnvelope({
    envelopeVersion: SELECTION_ENVELOPE_VERSION,
    schemaVersion: 1,
    state: input.state as DecisionState,
    instruction: input.instruction,
    optionsInOrder: input.optionsInOrder as Array<{ id: string; description: string }>,
    eligibleIds: input.eligibleIds as string[],
    selectableOrder: input.selectableOrder as string[],
    policy: {
      version: typeof input.policyVersion === "number" ? input.policyVersion : 1,
      domainClauseHash: policyHash,
    },
  });
  return recomputed === input.envelopeHash;
}
