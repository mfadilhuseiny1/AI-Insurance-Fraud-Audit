import { computeVersionHash, hashValue, ZERO_HASH, type Hex } from "./core";
import type { EvidenceBundle } from "./bundle";

/* Ways a dishonest sender could change a bundle, for the Verifier Desk's demonstration and the self-test. They edit a
   private copy in memory; nothing is ever written back. The desk shows the checks catching each one, and which checks
   a file alone cannot catch. */

export type TamperMode = "reading" | "claim" | "forge";
export const TAMPER_MODES: TamperMode[] = ["reading", "claim", "forge"];

/** One reading's value flipped in the last version, left signed as it was. */
export function editReading(b: EvidenceBundle): void {
  const r = b.versions[b.versions.length - 1].evidence.readings[3]?.reading;
  if (r) r.value = r.value === 1 ? 0 : 1;
}

/** The first version's claim rewritten, every hash left alone. */
export function editClaim(b: EvidenceBundle): void {
  (b.versions[0].claim as Record<string, unknown>).__edited = "a procedure added after the fact";
}

/**
 * Rewrite v1's claim and recompute EVERY hash that depends on it, down the chain of versions, and drop the reports that
 * named the old hashes. Nothing in the file contradicts itself any more, so a check of the file alone passes. Only the
 * ledger remembers that the claim used to say something else.
 */
export function forgeConsistently(b: EvidenceBundle): void {
  (b.versions[0].claim as Record<string, unknown>).__forged = "a procedure the faskes added after the fact";
  let previous: Hex | null = null;
  for (const v of b.versions) {
    const m = v.manifest;
    if (v.version === 1) m.claimHash = hashValue(v.claim);
    m.previousVersionHash = previous;
    m.versionHash = computeVersionHash({ claimId: m.claimId, claimVersion: m.claimVersion, claimHash: m.claimHash, evidenceRoot: m.evidenceRoot, readingCount: m.readingCount, previousVersionHash: m.previousVersionHash });
    v.ledger.version = { codingHash: m.claimHash, evidenceRoot: m.evidenceRoot, readingCount: m.readingCount, previousVersionHash: m.previousVersionHash ?? ZERO_HASH, versionHash: m.versionHash };
    v.ledger.decision = null;
    v.report = null;
    previous = m.versionHash;
  }
}

export function applyTamper(b: EvidenceBundle, mode: TamperMode): void {
  if (mode === "reading") editReading(b);
  else if (mode === "claim") editClaim(b);
  else forgeConsistently(b);
}
