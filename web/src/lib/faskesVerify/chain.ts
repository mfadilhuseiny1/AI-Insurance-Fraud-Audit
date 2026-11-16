import { Contract, JsonRpcProvider, Network } from "ethers";

import { ZERO_HASH, checkSignature, sameHex, type Hex } from "./core";
import { isAddress, type Check, type EvidenceBundle, type LedgerDecision, type LedgerValues } from "./bundle";

/* The second half of verification: ask the chain, not the sender, what was anchored. Read-only: this desk holds no wallet
   and sends no transaction. Recording a verdict or a payment needs the verifier's or the settlement operator's own key,
   which belongs on their machine, not in a shared web app. */

const ABI = [
  "function getClaim(bytes32 claimId) view returns (tuple(address faskes, uint8 status, uint32 versionCount, bytes32 lastReportHash, uint64 updatedAt))",
  "function getVersion(bytes32 claimId, uint32 version) view returns (tuple(bytes32 codingHash, bytes32 evidenceRoot, uint32 readingCount, uint64 submittedAt, bytes32 previousVersionHash, bytes32 versionHash))",
  "function getDecision(bytes32 claimId, uint32 version) view returns (tuple(uint8 verdict, address verifier, bytes32 verifierId, bytes32 reportHash, bytes32 rulesetVersion, bytes32 reportNonce, uint64 decidedAt, bytes32 decisionHash))",
  "function getSettlement(bytes32 claimId) view returns (tuple(address operator, bytes32 operatorId, bytes32 paymentRef, bytes32 amountCommitment, uint64 settledAt))",
  "function wasDeviceValidAt(address faskes, address device, uint64 timestamp) view returns (bool)",
];

const STATUS = ["None", "Submitted", "Pending", "Disputed", "Approved", "Settled"] as const;
export type ChainStatus = (typeof STATUS)[number];
export const VERDICT = ["Approve", "Pend", "Dispute"] as const;
export type VerdictName = (typeof VERDICT)[number];

/** A device may stamp a reading a little ahead of the chain's clock; beyond this the reading is dated after the claim existed. */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export interface ChainVersionView {
  version: number;
  submittedAt: number;
  versionHash: Hex;
}
export interface ChainDecisionView {
  version: number;
  verdict: VerdictName;
  verifier: string;
  verifierId: Hex;
  reportHash: Hex;
  rulesetVersion: Hex;
  decidedAt: number;
  decisionHash: Hex;
}
export interface ChainSnapshot {
  /** host:port only; the RPC url may carry a key */
  node: string;
  chainId: number;
  contract: string;
  status: ChainStatus;
  /** the wallet the contract holds as the claim's owner */
  faskesWallet: string | null;
  versionCount: number;
  versions: ChainVersionView[];
  decisions: ChainDecisionView[];
  settlement: { operator: string; paymentRef: Hex; amountCommitment: Hex; settledAt: number } | null;
  devices: Array<{ address: string; registered: boolean; lastReadingAt: number }>;
  /** what verifyBundle compares each version with (index 0 is version 1) */
  ledger: LedgerValues[];
}

export type ChainOutcome =
  | { reachable: false; node: string; reason: string }
  | { reachable: true; node: string; chainId: number; found: false; reason: string }
  | { reachable: true; node: string; found: true; snapshot: ChainSnapshot };

const nodeOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
};

async function rpcChainId(url: string, ms: number): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(ms),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: string };
  const id = Number(body.result);
  if (!Number.isInteger(id)) throw new Error("the node did not answer eth_chainId");
  return id;
}

/** Read what the ledger holds for the bundle's claim. Never throws: an unreachable chain is a result, not a crash. */
export async function readChain(b: EvidenceBundle, rpcUrl: string, timeoutMs = 15_000): Promise<ChainOutcome> {
  const node = nodeOf(rpcUrl);
  let chainId: number;
  try {
    chainId = await rpcChainId(rpcUrl, 4_000);
  } catch (e) {
    return { reachable: false, node, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!isAddress(b.ledger.contract)) return { reachable: true, node, chainId, found: false, reason: "the bundle names no valid contract address" };

  const network = Network.from(chainId);
  const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network, cacheTimeout: -1, batchMaxCount: 1 });
  try {
    return await Promise.race([
      load(b, provider, node, chainId),
      new Promise<ChainOutcome>((resolve) => setTimeout(() => resolve({ reachable: false, node, reason: `the node did not answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)),
    ]);
  } catch (e) {
    return { reachable: false, node, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  } finally {
    provider.destroy();
  }
}

async function load(b: EvidenceBundle, provider: JsonRpcProvider, node: string, chainId: number): Promise<ChainOutcome> {
  const code = await provider.getCode(b.ledger.contract);
  if (code === "0x") return { reachable: true, node, chainId, found: false, reason: "no contract is deployed at the address the bundle names, on this chain" };
  const c = new Contract(b.ledger.contract, ABI, provider);
  const claimId = b.claim.claimId;
  const claim = await c.getClaim(claimId);
  const status = STATUS[Number(claim.status)] ?? "None";
  const count = Number(claim.versionCount);

  const versions: ChainVersionView[] = [];
  const decisions: ChainDecisionView[] = [];
  const ledger: LedgerValues[] = [];
  for (let v = 1; v <= count; v++) {
    const [x, d] = await Promise.all([c.getVersion(claimId, v), c.getDecision(claimId, v)]);
    versions.push({ version: v, submittedAt: Number(x.submittedAt) * 1000, versionHash: x.versionHash });
    let decision: LedgerDecision | null = null;
    if (!sameHex(d.reportHash, ZERO_HASH)) {
      decision = {
        verdict: Number(d.verdict),
        verifierId: d.verifierId,
        reportHash: d.reportHash,
        rulesetVersion: d.rulesetVersion,
        reportNonce: d.reportNonce,
        decidedAtSec: Number(d.decidedAt),
        decisionHash: d.decisionHash,
      };
      decisions.push({ version: v, verdict: VERDICT[Number(d.verdict)] ?? "Pend", verifier: d.verifier, verifierId: d.verifierId, reportHash: d.reportHash, rulesetVersion: d.rulesetVersion, decidedAt: Number(d.decidedAt) * 1000, decisionHash: d.decisionHash });
    }
    ledger.push({
      version: { codingHash: x.codingHash, evidenceRoot: x.evidenceRoot, readingCount: Number(x.readingCount), previousVersionHash: x.previousVersionHash, versionHash: x.versionHash },
      decision,
    });
  }

  let settlement: ChainSnapshot["settlement"] = null;
  if (status === "Settled") {
    const s = await c.getSettlement(claimId);
    settlement = { operator: s.operator, paymentRef: s.paymentRef, amountCommitment: s.amountCommitment, settledAt: Number(s.settledAt) * 1000 };
  }

  // each device that signed a reading: was its key registered to the claim's owner, and not yet revoked when it last signed?
  const faskesWallet: string | null = status === "None" ? null : claim.faskes;
  const last = new Map<string, number>();
  for (const v of b.versions) {
    for (const s of v.evidence.readings) {
      if (!checkSignature(s).ok) continue;
      const key = s.reading.device.toLowerCase();
      last.set(key, Math.max(last.get(key) ?? 0, s.reading.t + s.reading.intervalSec * 1000));
    }
  }
  const devices = await Promise.all(
    [...last.entries()].map(async ([address, lastReadingAt]) => ({
      address,
      lastReadingAt,
      registered: faskesWallet ? Boolean(await c.wasDeviceValidAt(faskesWallet, address, Math.floor(lastReadingAt / 1000))) : false,
    })),
  );

  return { reachable: true, node, found: true, snapshot: { node, chainId, contract: b.ledger.contract, status, faskesWallet, versionCount: count, versions, decisions, settlement, devices, ledger } };
}

/** Checks that need the chain and are not about one version's files. */
export function chainChecks(b: EvidenceBundle, s: ChainSnapshot): Check[] {
  const out: Check[] = [];
  const idOk = b.ledger.chainId === undefined || b.ledger.chainId === s.chainId;
  out.push({ id: "chain", ok: idOk, detail: idOk ? `chain ${s.chainId}, contract found at the address the bundle names` : `the bundle was made on chain ${b.ledger.chainId}, this node is chain ${s.chainId}` });

  const known = s.status !== "None";
  out.push({ id: "claim-on-chain", ok: known, detail: known ? `the ledger knows this claim (${s.status}, ${s.versionCount} version${s.versionCount > 1 ? "s" : ""})` : "the ledger has no record of this claim id" });

  const unregistered = s.devices.filter((d) => !d.registered);
  out.push({
    id: "devices-registered",
    ok: s.devices.length > 0 && unregistered.length === 0,
    detail: unregistered.length > 0 ? `${unregistered.length} of ${s.devices.length} signing device${s.devices.length > 1 ? "s were" : " was"} not registered to the claim's owner, or revoked before it signed` : s.devices.length === 0 ? "no valid signature to check a device for" : `all ${s.devices.length} signing device${s.devices.length > 1 ? "s were" : " was"} registered to the claim's owner and not revoked at its last reading`,
  });

  // commit-before-claim: a reading dated after the moment the version reached the chain cannot have been part of it
  const late: number[] = [];
  for (const v of b.versions) {
    const at = s.versions[v.version - 1]?.submittedAt;
    if (at === undefined) continue;
    late.push(v.evidence.readings.filter((r) => r.reading.t > at + CLOCK_TOLERANCE_MS).length);
  }
  const lateTotal = late.reduce((a, c) => a + c, 0);
  out.push({ id: "timing", ok: lateTotal === 0, detail: lateTotal === 0 ? "no reading is dated after the version reached the chain" : `${lateTotal} reading${lateTotal > 1 ? "s are" : " is"} dated after the version reached the chain` });
  return out;
}
