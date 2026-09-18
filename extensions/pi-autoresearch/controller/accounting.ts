/**
 * Budget accounting for selector replay and paired trials (ticket 14).
 *
 * AGENT_HANDOFF.md §11.4 requires every spend category to be counted:
 * proposals, planning (question-plan generation), selection, implementation,
 * failures, retries, cancellations, checks, compaction, and benchmark compute.
 * One-time setup is separated from steady-state usage but included in the
 * user-facing total. Missing prices/usage stay unknown (null), never zero.
 * Provider price tables are snapshots, not constants.
 *
 * Pi RPC double-counting rule (§11.4, [S18]): the harness may consume Pi RPC
 * session usage/cost statistics. When Jev tool usage is already reported
 * through Pi, it must not be added a second time — see
 * {@link mergePiAndJevUsage}.
 *
 * This module is pure (no I/O, no network, no paid calls). Cheap fixtures
 * verify it; real model calls belong to later tickets.
 *
 * Plan source: AGENT_HANDOFF.md §11.4 + §13 (M2).
 */

/** Every spend category the decisive comparison must count. Fixed order for stable reports. */
export const SPEND_CATEGORIES = [
  "proposals",
  "planning",
  "selection",
  "implementation",
  "failures",
  "retries",
  "cancellations",
  "checks",
  "compaction",
  "benchmarkCompute",
] as const;

/** One spend category. */
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

/** One-time setup vs per-experiment steady-state. Setup is separated but included. */
export type SpendPhase = "setup" | "steady";

export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

function accountingError(message: string): never {
  throw new AccountingError(message);
}

/** One ledger charge. `costUsd: null` means unknown (missing price/usage) — never zero-filled. */
export interface SpendEntry {
  category: SpendCategory;
  phase: SpendPhase;
  /** Cost in USD, or null when the price or usage is unreported. */
  costUsd: number | null;
  wallMs?: number;
  calls?: number;
  experiments?: number;
  note?: string;
}

/** Token counts where null means unknown (mirrors the Jev adapter's unknown rule). */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function requireCategory(value: unknown): SpendCategory {
  if (typeof value === "string" && (SPEND_CATEGORIES as readonly string[]).includes(value)) {
    return value as SpendCategory;
  }
  accountingError(`category must be one of [${SPEND_CATEGORIES.join(", ")}], got ${JSON.stringify(value)}`);
}

function requirePhase(value: unknown): SpendPhase {
  if (value === "setup" || value === "steady") return value;
  accountingError(`phase must be "setup" or "steady", got ${JSON.stringify(value)}`);
}

function requireCost(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  accountingError(`costUsd must be a finite number >= 0 or null (unknown), got ${JSON.stringify(value)}`);
}

function requireCount(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  accountingError(`${field} must be a finite number >= 0, got ${JSON.stringify(value)}`);
}

/** Validate one spend entry. Throws `AccountingError` on any defect. */
export function validateSpendEntry(entry: SpendEntry): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    accountingError("spend entry must be an object");
  }
  requireCategory((entry as SpendEntry).category);
  requirePhase((entry as SpendEntry).phase);
  requireCost((entry as SpendEntry).costUsd);
  requireCount((entry as SpendEntry).wallMs, "wallMs");
  requireCount((entry as SpendEntry).calls, "calls");
  requireCount((entry as SpendEntry).experiments, "experiments");
}

/** Totals for one slice (one category, one phase, or the grand total). */
export interface SpendSlice {
  /** Null while any contributing charge was unknown. */
  costUsd: number | null;
  costUnknown: boolean;
  wallMs: number;
  calls: number;
  experiments: number;
  charges: number;
}

/** Full ledger totals: per-category, setup vs steady-state, and the included grand total. */
export interface SpendTotals {
  byCategory: Record<SpendCategory, SpendSlice>;
  setup: SpendSlice;
  steady: SpendSlice;
  /** User-facing total: setup + steady-state, always included together. */
  total: SpendSlice;
}

function emptySlice(): SpendSlice {
  return { costUsd: 0, costUnknown: false, wallMs: 0, calls: 0, experiments: 0, charges: 0 };
}

function addInto(slice: SpendSlice, entry: SpendEntry): void {
  slice.charges += 1;
  slice.wallMs += entry.wallMs ?? 0;
  slice.calls += entry.calls ?? 0;
  slice.experiments += entry.experiments ?? 0;
  if (entry.costUsd === null || entry.costUsd === undefined) {
    slice.costUnknown = true;
    slice.costUsd = null;
  } else if (!slice.costUnknown) {
    slice.costUsd = (slice.costUsd as number) + entry.costUsd;
  }
}

/** In-memory spend ledger. Pure; no I/O. */
export interface SpendLedger {
  readonly entries: SpendEntry[];
  charge(entry: SpendEntry): void;
  totals(): SpendTotals;
}

/** Create an empty spend ledger. */
export function createSpendLedger(): SpendLedger {
  const entries: SpendEntry[] = [];
  return {
    get entries(): SpendEntry[] {
      return [...entries];
    },
    charge(entry: SpendEntry): void {
      validateSpendEntry(entry);
      entries.push({
        category: entry.category,
        phase: entry.phase,
        costUsd: entry.costUsd,
        ...(entry.wallMs !== undefined ? { wallMs: entry.wallMs } : {}),
        ...(entry.calls !== undefined ? { calls: entry.calls } : {}),
        ...(entry.experiments !== undefined ? { experiments: entry.experiments } : {}),
        ...(entry.note !== undefined ? { note: entry.note } : {}),
      });
    },
    totals(): SpendTotals {
      const byCategory = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, emptySlice()])) as Record<
        SpendCategory,
        SpendSlice
      >;
      const setup = emptySlice();
      const steady = emptySlice();
      const total = emptySlice();
      for (const entry of entries) {
        addInto(byCategory[entry.category], entry);
        addInto(entry.phase === "setup" ? setup : steady, entry);
        addInto(total, entry);
      }
      return { byCategory, setup, steady, total };
    },
  };
}

/**
 * Derive a USD cost from token counts and a price table. Any unknown input
 * (null tokens, missing price) yields null — missing prices stay unknown,
 * never zero. Price tables are snapshots, not constants: pass the table used
 * and record which one it was.
 */
export function costFromTokens(
  usage: TokenUsage,
  prices: { inputPerToken?: number | null; outputPerToken?: number | null } | null | undefined,
): number | null {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    accountingError("usage must be { inputTokens, outputTokens }");
  }
  const { inputTokens, outputTokens } = usage;
  if (prices === null || prices === undefined) return null;
  const { inputPerToken, outputPerToken } = prices;
  if (
    (inputTokens !== null && (inputPerToken === null || inputPerToken === undefined)) ||
    (outputTokens !== null && (outputPerToken === null || outputPerToken === undefined))
  ) {
    return null;
  }
  if (inputTokens === null && outputTokens === null) return null;
  let cost = 0;
  if (inputTokens !== null) {
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0) {
      accountingError(`inputTokens must be a finite number >= 0 or null, got ${JSON.stringify(inputTokens)}`);
    }
    if (typeof inputPerToken !== "number" || !Number.isFinite(inputPerToken) || inputPerToken < 0) {
      accountingError("inputPerToken must be a finite number >= 0");
    }
    cost += inputTokens * (inputPerToken as number);
  }
  if (outputTokens !== null) {
    if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0) {
      accountingError(`outputTokens must be a finite number >= 0 or null, got ${JSON.stringify(outputTokens)}`);
    }
    if (typeof outputPerToken !== "number" || !Number.isFinite(outputPerToken) || outputPerToken < 0) {
      accountingError("outputPerToken must be a finite number >= 0");
    }
    cost += outputTokens * (outputPerToken as number);
  }
  return cost;
}

/**
 * Merge Pi RPC session usage with separately captured Jev tool usage.
 *
 * When Jev tool usage is already reported through Pi (`jevIncludedInPi:
 * true`), the Jev figures are informational only and the Pi totals stand —
 * adding them again would double-count shared-model usage. Otherwise the
 * known counts sum, and any unknown side keeps the merged side unknown
 * (unknown stays unknown, never zero-filled).
 */
export function mergePiAndJevUsage(
  pi: TokenUsage,
  jev: TokenUsage,
  opts: { jevIncludedInPi: boolean },
): TokenUsage {
  for (const [label, usage] of [["pi", pi], ["jev", jev]] as const) {
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
      accountingError(`${label} usage must be { inputTokens, outputTokens }`);
    }
  }
  if (opts.jevIncludedInPi) {
    return { inputTokens: pi.inputTokens, outputTokens: pi.outputTokens };
  }
  const merge = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : a + b;
  return {
    inputTokens: merge(pi.inputTokens, jev.inputTokens),
    outputTokens: merge(pi.outputTokens, jev.outputTokens),
  }
}

/**
 * Accounting rulebook summary. Travels with reports so the separation and
 * the unknown/double-count rules are never silently dropped.
 */
export const ACCOUNTING_RULES =
  "Count proposals, planning, selection, implementation, failures, retries, " +
  "cancellations, checks, compaction, and benchmark compute. Separate one-time " +
  "setup from steady-state usage but include setup in the user-facing total. " +
  "Missing prices/usage stay unknown, never zero. When Jev tool usage is " +
  "already reported through Pi RPC, do not add it a second time.";
