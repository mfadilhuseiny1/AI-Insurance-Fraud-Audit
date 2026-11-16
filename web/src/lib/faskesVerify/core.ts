import { AbiCoder, concat, getBytes, keccak256, toUtf8Bytes, verifyMessage } from "ethers";

/* The verifier's own implementation of the claim-integrity formats a faskes produces (D:/BluesandAI/ai-jkn,
   lib/faskes). It deliberately shares no code with the faskes server: a verifier that imports the sender's code checks the
   sender against itself. What must agree is the FORMAT: canonical JSON, keccak256, EIP-191 reading signatures, the
   Merkle scheme of OpenZeppelin's MerkleProof, and the two domain-separated hashes the ClaimLedger contract computes. */

export type Hex = `0x${string}`;
export const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;
export const SCHEMA_VERSION = "1.0";

/** Canonical JSON: keys sorted, no whitespace, undefined dropped, so the same value is the same bytes on every machine. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported type ${typeof value}`);
  }
}

export const keccakText = (text: string): Hex => keccak256(toUtf8Bytes(text)) as Hex;
export const hashValue = (value: unknown): Hex => keccakText(canonicalize(value));
export const sameHex = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/* -------------------------------------------------------------------- readings */

export type DeviceKind = "ventilator" | "hemodialysis" | "icu-bed" | "ward-bed" | "icu-monitor";

export interface Reading {
  v: 1;
  /** the device's address (its public key) */
  device: string;
  kind: DeviceKind;
  /** pseudonymous episode id, never a name or an identity number */
  episode: string;
  /** epoch ms at the start of the sampled interval */
  t: number;
  /** the device's own counter, +1 per reading: a gap means readings are missing */
  seq: number;
  metric: string;
  value: number;
  intervalSec: number;
}

export interface SignedReading {
  reading: Reading;
  hash: Hex;
  sig: Hex;
}

export const readingHash = (r: Reading): Hex => keccakText(canonicalize(r));
/** A leaf is the reading hash hashed again, so a leaf can never be taken for an inner node. */
export const leafOf = (hash: Hex): Hex => keccak256(getBytes(hash)) as Hex;

/* Recovering a signer is the slow step (1-2 ms), and one desk session checks the same thousands of readings again after a
   change of view. The result depends only on (hash, sig); the hash itself is recomputed from the reading every time, so an
   edited reading is still caught. */
const signerCache = new Map<string, string>();
const SIGNER_CACHE_MAX = 100_000;

export type SignatureCheck =
  | { ok: true; signer: string }
  | { ok: false; reason: "hash-mismatch" | "bad-signature" | "wrong-signer" };

/** The reading must hash to `hash`, and `sig` must come from the key the reading names as its device. */
export function checkSignature(s: SignedReading): SignatureCheck {
  let recomputed: Hex;
  try {
    recomputed = readingHash(s.reading);
  } catch {
    return { ok: false, reason: "hash-mismatch" };
  }
  if (recomputed !== s.hash) return { ok: false, reason: "hash-mismatch" };
  const key = `${s.hash}|${s.sig}`;
  let signer = signerCache.get(key);
  if (signer === undefined) {
    try {
      signer = verifyMessage(getBytes(s.hash), s.sig);
    } catch {
      return { ok: false, reason: "bad-signature" };
    }
    if (signerCache.size >= SIGNER_CACHE_MAX) signerCache.clear();
    signerCache.set(key, signer);
  }
  return sameHex(signer, s.reading.device) ? { ok: true, signer } : { ok: false, reason: "wrong-signer" };
}

/** Deterministic order, so every party builds the same tree from the same readings. */
function sortReadings(items: readonly SignedReading[]): SignedReading[] {
  return items.slice().sort((a, b) => {
    const x = a.reading;
    const y = b.reading;
    if (x.t !== y.t) return x.t - y.t;
    if (x.device !== y.device) return x.device < y.device ? -1 : 1;
    if (x.metric !== y.metric) return x.metric < y.metric ? -1 : 1;
    return x.seq - y.seq;
  });
}

const pairHash = (a: Hex, b: Hex): Hex => keccak256(BigInt(a) <= BigInt(b) ? concat([a, b]) : concat([b, a])) as Hex;

/** Merkle root, sorted pairs, an odd node at the end of a layer carried up unchanged (OpenZeppelin MerkleProof). */
export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) return ZERO_HASH;
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? pairHash(layer[i], layer[i + 1]) : layer[i]);
    layer = next;
  }
  return layer[0];
}

/** Order the readings, drop duplicates, and compute their Merkle root. */
export function sealReadings(readings: readonly SignedReading[]): { ordered: SignedReading[]; root: Hex } {
  const unique = new Map<string, SignedReading>();
  for (const s of readings) unique.set(s.hash, s);
  const ordered = sortReadings([...unique.values()]);
  return { ordered, root: merkleRoot(ordered.map((s) => leafOf(s.hash))) };
}

/* ------------------------------------------------------------ ledger commitments */

const coder = AbiCoder.defaultAbiCoder();
export const VERSION_DOMAIN = keccak256(toUtf8Bytes("ai-jkn.claim-version/1")) as Hex;
export const DECISION_DOMAIN = keccak256(toUtf8Bytes("ai-jkn.claim-decision/1")) as Hex;

export interface VersionFields {
  claimId: Hex;
  claimVersion: number;
  claimHash: Hex;
  evidenceRoot: Hex;
  readingCount: number;
  previousVersionHash: Hex | null;
}

/** What ClaimLedger.submitClaim computes: keccak256(abi.encode(domain, claimId, version, coding, root, n, previous)). */
export function computeVersionHash(f: VersionFields): Hex {
  return keccak256(
    coder.encode(
      ["bytes32", "bytes32", "uint32", "bytes32", "bytes32", "uint32", "bytes32"],
      [VERSION_DOMAIN, f.claimId, f.claimVersion, f.claimHash, f.evidenceRoot, f.readingCount, f.previousVersionHash ?? ZERO_HASH],
    ),
  ) as Hex;
}

export interface DecisionFields {
  claimId: Hex;
  claimVersion: number;
  codingHash: Hex;
  evidenceRoot: Hex;
  reportHash: Hex;
  verifierId: Hex;
  /** 0 Approve, 1 Pend, 2 Dispute */
  verdict: number;
  rulesetVersion: Hex;
  decidedAtSec: number;
  reportNonce: Hex;
}

/** What ClaimLedger.recordVerdict computes. */
export function computeDecisionHash(d: DecisionFields): Hex {
  return keccak256(
    coder.encode(
      ["bytes32", "bytes32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint8", "bytes32", "uint64", "bytes32"],
      [DECISION_DOMAIN, d.claimId, d.claimVersion, d.codingHash, d.evidenceRoot, d.reportHash, d.verifierId, d.verdict, d.rulesetVersion, d.decidedAtSec, d.reportNonce],
    ),
  ) as Hex;
}
