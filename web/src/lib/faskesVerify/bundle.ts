import {
  SCHEMA_VERSION,
  ZERO_HASH,
  checkSignature,
  computeDecisionHash,
  computeVersionHash,
  hashValue,
  sameHex,
  sealReadings,
  type DeviceKind,
  type Hex,
  type SignedReading,
} from "./core";

/* An evidence bundle is everything a verifier needs to check one claim without the faskes's server: every version of the
   claim with its signed device readings and audit report, and the values each was anchored with. This file parses it
   (it is untrusted input) and recomputes every hash, signature, link and decision hash. What it cannot do alone is prove
   the ledger values inside the bundle are the real ones: chain.ts reads them from the chain itself. */

export const BUNDLE_FORMAT = "ai-jkn.evidence-bundle/2";
export const MAX_VERSIONS = 50;
export const MAX_READINGS = 200_000;

export interface LedgerVersion {
  codingHash: Hex;
  evidenceRoot: Hex;
  readingCount: number;
  previousVersionHash: Hex;
  versionHash: Hex;
}
export interface LedgerDecision {
  verdict: number;
  verifierId: Hex;
  reportHash: Hex;
  rulesetVersion: Hex;
  reportNonce: Hex;
  decidedAtSec: number;
  decisionHash: Hex;
}
export interface Manifest {
  claimId: Hex;
  claimVersion: number;
  claimHash: Hex;
  evidenceRoot: Hex;
  readingCount: number;
  previousVersionHash: Hex | null;
  versionHash: Hex;
  submittedAt: string;
  submissionTransaction: Hex;
  schemaVersion: string;
}
export interface EvidenceFile {
  schemaVersion: string;
  evidenceRoot: Hex;
  readingCount: number;
  readingHashes: Hex[];
  readings: SignedReading[];
}
export interface ReportFile {
  schemaVersion: string;
  reportHash: Hex;
  body: Record<string, unknown>;
  verdict: "Approve" | "Pend" | "Dispute";
  decisionHash: Hex;
  verdictTransaction: Hex;
  verdictBlock: number;
  recordedAt: string;
}
export interface BundleVersion {
  version: number;
  manifest: Manifest;
  claim: unknown;
  evidence: EvidenceFile;
  report: ReportFile | null;
  ledger: { version: LedgerVersion; decision: LedgerDecision | null };
}
export interface EvidenceBundle {
  format: typeof BUNDLE_FORMAT;
  generatedAt: number;
  claim: { claimNo: string; claimId: Hex; faskes: string; episode: string };
  ledger: { chainId?: number; contract: string; status: string; versionCount: number };
  versions: BundleVersion[];
  devices: Array<{ address: string; kind: string; label: string }>;
  note: string;
}

/* ------------------------------------------------------------------- parsing */

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown, max = 200): x is string => typeof x === "string" && x.length <= max;
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isHex = (x: unknown, bytes: number): x is Hex => typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(x);
export const isAddress = (x: unknown): x is string => isHex(x, 20);

/** Parse untrusted JSON into a bundle, or say why not. Shape only: every claim about the content is checked later. */
export function parseBundle(raw: unknown): { ok: true; bundle: EvidenceBundle } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isObj(raw)) return bad("The file is not a JSON object.");
  if (raw.format !== BUNDLE_FORMAT) return bad(`Unknown bundle format ${isStr(raw.format) ? `"${raw.format}"` : "(none)"}; this desk reads ${BUNDLE_FORMAT}.`);
  const claim = raw.claim;
  if (!isObj(claim) || !isStr(claim.claimNo, 40) || !isHex(claim.claimId, 32) || !isStr(claim.faskes) || !isStr(claim.episode)) return bad("The claim header is missing or malformed.");
  const ledger = raw.ledger;
  if (!isObj(ledger) || !isAddress(ledger.contract) || !isInt(ledger.versionCount)) return bad("The ledger header is missing or malformed.");
  if (!Array.isArray(raw.versions) || raw.versions.length === 0) return bad("The bundle holds no versions.");
  if (raw.versions.length > MAX_VERSIONS) return bad(`More than ${MAX_VERSIONS} versions.`);
  if (!Array.isArray(raw.devices)) return bad("The device list is missing.");
  let readings = 0;
  for (const [i, v] of raw.versions.entries()) {
    const at = `Version entry ${i + 1}`;
    if (!isObj(v) || !isInt(v.version) || !isObj(v.manifest) || !isObj(v.evidence) || !isObj(v.ledger)) return bad(`${at} is malformed.`);
    const m = v.manifest;
    if (!isHex(m.claimId, 32) || !isInt(m.claimVersion) || !isHex(m.claimHash, 32) || !isHex(m.evidenceRoot, 32) || !isInt(m.readingCount) || !isHex(m.versionHash, 32)) return bad(`${at}: the manifest is malformed.`);
    if (m.previousVersionHash !== null && !isHex(m.previousVersionHash, 32)) return bad(`${at}: the manifest's previous-version link is malformed.`);
    const e = v.evidence;
    if (!Array.isArray(e.readings) || !Array.isArray(e.readingHashes) || !isHex(e.evidenceRoot, 32) || !isInt(e.readingCount)) return bad(`${at}: the evidence is malformed.`);
    readings += e.readings.length;
    if (readings > MAX_READINGS) return bad(`More than ${MAX_READINGS.toLocaleString("en-US")} readings.`);
    for (const s of e.readings) {
      if (!isObj(s) || !isObj(s.reading) || !isHex(s.hash, 32) || typeof s.sig !== "string") return bad(`${at}: a signed reading is malformed.`);
      const r = s.reading;
      if (!isAddress(r.device) || !isStr(r.metric, 60) || !isStr(r.episode, 40) || typeof r.t !== "number" || !isInt(r.seq) || typeof r.value !== "number" || !isInt(r.intervalSec)) return bad(`${at}: a reading is missing a field.`);
    }
    const l = v.ledger;
    if (!isObj(l.version)) return bad(`${at}: the ledger values are missing.`);
  }
  for (const d of raw.devices) if (!isObj(d) || !isAddress(d.address)) return bad("A device entry is malformed.");
  return { ok: true, bundle: raw as unknown as EvidenceBundle };
}

/* -------------------------------------------------------------- verification */

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}
export interface VersionResult {
  version: number;
  ok: boolean;
  checks: Check[];
  versionHash?: Hex;
  previousVersionHash?: Hex | null;
  reportHash?: Hex;
}
export interface BundleResult {
  ok: boolean;
  /** where the ledger values came from: the bundle's own copy, or the chain */
  ledgerSource: "bundle" | "chain";
  checks: Check[];
  versions: VersionResult[];
}

export interface LedgerValues {
  version: LedgerVersion | null;
  decision: LedgerDecision | null;
}

const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…` : "—");

function verifyVersion(claimId: Hex, v: BundleVersion, previous: Manifest | null, ledger: LedgerValues): VersionResult {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const { manifest, claim, evidence, report } = v;

  const filesOk = manifest.schemaVersion === SCHEMA_VERSION && manifest.claimVersion === v.version && sameHex(manifest.claimId, claimId);
  add("files", filesOk, filesOk ? "the manifest names this claim and version" : manifest.schemaVersion !== SCHEMA_VERSION ? `unknown schema ${String(manifest.schemaVersion)}` : "the manifest names another claim or version");

  const claimHash = hashValue(claim);
  const claimOk = sameHex(claimHash, manifest.claimHash);
  add("claim-hash", claimOk, claimOk ? "the claim document hashes to the manifest" : `the claim document hashes to ${short(claimHash)}, the manifest says ${short(manifest.claimHash)}`);

  const badSig = evidence.readings.filter((r) => !checkSignature(r).ok).length;
  const sealed = sealReadings(evidence.readings);
  const rootOk = sameHex(sealed.root, manifest.evidenceRoot) && sameHex(evidence.evidenceRoot, manifest.evidenceRoot);
  const listOk = sealed.ordered.length === evidence.readingHashes.length && sealed.ordered.every((s, i) => sameHex(s.hash, evidence.readingHashes[i]));
  const countOk = manifest.readingCount === sealed.ordered.length && evidence.readingCount === sealed.ordered.length;
  add(
    "evidence",
    badSig === 0 && rootOk && listOk && countOk,
    badSig > 0
      ? `${badSig} reading signature${badSig > 1 ? "s" : ""} fail`
      : !rootOk
        ? "the readings do not hash to the evidence root"
        : !listOk || !countOk
          ? "the reading list or count differs from the manifest"
          : `${sealed.ordered.length.toLocaleString("en-US")} signed readings hash to the evidence root`,
  );

  const vh = computeVersionHash({ claimId: manifest.claimId, claimVersion: manifest.claimVersion, claimHash: manifest.claimHash, evidenceRoot: manifest.evidenceRoot, readingCount: manifest.readingCount, previousVersionHash: manifest.previousVersionHash });
  const vhOk = sameHex(vh, manifest.versionHash);
  add("version-hash", vhOk, vhOk ? "the version hash recomputes" : "the manifest does not hash to its version hash");

  if (v.version === 1) {
    const ok = manifest.previousVersionHash === null;
    add("link", ok, ok ? "first version, no predecessor" : "version 1 names a predecessor");
  } else {
    const ok = previous !== null && sameHex(previous.versionHash, manifest.previousVersionHash);
    add("link", ok, ok ? `links to the version hash of v${v.version - 1}` : previous ? `v${v.version - 1} has a different version hash` : `v${v.version - 1} is missing`);
  }

  if (ledger.version) {
    const l = ledger.version;
    const ok =
      sameHex(l.codingHash, manifest.claimHash) &&
      sameHex(l.evidenceRoot, manifest.evidenceRoot) &&
      l.readingCount === manifest.readingCount &&
      sameHex(l.versionHash, manifest.versionHash) &&
      sameHex(l.previousVersionHash, manifest.previousVersionHash ?? ZERO_HASH);
    add("ledger", ok, ok ? "every commitment equals what the ledger holds" : "the files do not match what the ledger holds for this version");
  } else {
    add("ledger", false, "the ledger has no such version");
  }

  const decision = ledger.decision && !sameHex(ledger.decision.reportHash, ZERO_HASH) ? ledger.decision : null;
  if (report || decision) {
    if (!report) {
      add("report", false, "the ledger holds a decision for this version, but the audit report is not in the bundle");
    } else {
      const hash = hashValue(report.body);
      const body = report.body as { claimVersion?: number; codingHash?: string; evidenceRoot?: string };
      let ok = sameHex(hash, report.reportHash) && body.claimVersion === v.version && sameHex(body.codingHash, manifest.claimHash) && sameHex(body.evidenceRoot, manifest.evidenceRoot);
      let detail = ok ? "the report hashes to its hash and is about this version" : "the report does not match its hash, or is about another version";
      if (ok && decision) {
        const recomputed = computeDecisionHash({
          claimId,
          claimVersion: v.version,
          codingHash: manifest.claimHash,
          evidenceRoot: manifest.evidenceRoot,
          reportHash: decision.reportHash,
          verifierId: decision.verifierId,
          verdict: decision.verdict,
          rulesetVersion: decision.rulesetVersion,
          decidedAtSec: decision.decidedAtSec,
          reportNonce: decision.reportNonce,
        });
        ok = sameHex(decision.reportHash, report.reportHash) && sameHex(recomputed, decision.decisionHash) && sameHex(report.decisionHash, decision.decisionHash);
        detail = ok ? "the report and the decision on the ledger agree, and the decision hash recomputes" : "the report or its decision hash differs from the ledger";
      }
      add("report", ok, detail);
    }
  }

  return { version: v.version, ok: checks.every((c) => c.ok), checks, versionHash: manifest.versionHash, previousVersionHash: manifest.previousVersionHash, reportHash: report?.reportHash };
}

/**
 * Verify a parsed bundle. `ledger` replaces the ledger values the bundle carries about itself (values[0] is version 1) and
 * the version count it claims: pass what was read from the chain and the result no longer depends on the sender's word for
 * what the chain says. A bundle that lacks a version the chain holds fails the `versions` check.
 */
export function verifyBundle(b: EvidenceBundle, ledger?: { values: LedgerValues[]; versionCount: number }): BundleResult {
  const checks: Check[] = [];
  const versions: VersionResult[] = [];
  const expected = ledger?.versionCount ?? b.ledger.versionCount;
  const contiguous = b.versions.length === expected && b.versions.every((v, i) => v.version === i + 1);
  checks.push({
    id: "versions",
    ok: contiguous,
    detail: contiguous ? `${b.versions.length} version${b.versions.length > 1 ? "s" : ""}, numbered without gaps` : `the bundle holds ${b.versions.length} version(s) for a ledger count of ${expected}, or the numbering has a gap`,
  });

  for (const [i, v] of b.versions.entries()) {
    const values: LedgerValues = ledger ? (ledger.values[i] ?? { version: null, decision: null }) : { version: v.ledger.version, decision: v.ledger.decision ?? null };
    let r: VersionResult;
    try {
      r = verifyVersion(b.claim.claimId, v, i > 0 ? b.versions[i - 1].manifest : null, values);
    } catch (e) {
      r = { version: v.version, ok: false, checks: [{ id: "files", ok: false, detail: `this version could not be read: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    versions.push(r);
    const failed = r.checks.filter((c) => !c.ok);
    checks.push({ id: `v${v.version}`, ok: r.ok, detail: r.ok ? `v${v.version}: claim, evidence, link, ledger values${v.report ? " and report" : ""} all verify` : `v${v.version}: ${failed.map((c) => `${c.id} (${c.detail})`).join("; ")}` });
  }

  const foreign = b.versions.reduce((n, v) => n + v.evidence.readings.filter((s) => s.reading.episode !== b.claim.episode).length, 0);
  checks.push({ id: "episode", ok: foreign === 0, detail: foreign === 0 ? "every reading belongs to the claim's episode" : `${foreign} reading${foreign > 1 ? "s" : ""} belong to another episode` });

  const known = new Set(b.devices.map((d) => d.address.toLowerCase()));
  const signers = new Set(b.versions.flatMap((v) => v.evidence.readings.filter((s) => checkSignature(s).ok).map((s) => s.reading.device.toLowerCase())));
  const unknown = [...signers].filter((d) => !known.has(d));
  checks.push({ id: "devices", ok: unknown.length === 0, detail: unknown.length === 0 ? `${known.size} signing device${known.size === 1 ? "" : "s"} listed` : `${unknown.length} signer${unknown.length > 1 ? "s are" : " is"} not in the bundle's device list` });

  return { ok: checks.every((c) => c.ok), ledgerSource: ledger ? "chain" : "bundle", checks, versions };
}

/* ------------------------------------------------------------ what the evidence shows */

export const METRIC_LABEL: Record<string, { label: string; kind: DeviceKind; binary: boolean }> = {
  ventilation_active: { label: "Ventilator on", kind: "ventilator", binary: true },
  dialysis_active: { label: "Dialysis running", kind: "hemodialysis", binary: true },
  icu_bed_occupied: { label: "ICU bed occupied", kind: "icu-bed", binary: true },
  bed_occupied: { label: "Ward bed occupied", kind: "ward-bed", binary: true },
  spo2: { label: "SpO2", kind: "icu-monitor", binary: false },
  heart_rate: { label: "Heart rate", kind: "icu-monitor", binary: false },
};

export interface MetricView {
  metric: string;
  label: string;
  binary: boolean;
  samples: number;
  /** binary metrics: hours the state was 1 */
  activeHours?: number;
  /** other metrics */
  mean?: number;
  min?: number;
  max?: number;
  /** readings missing by the device's own counter */
  missing: number;
  /** binary metrics: share of each time slice the state was on, null where no reading falls */
  ribbon?: (number | null)[];
}
export interface EvidenceView {
  version: number;
  readingCount: number;
  devices: string[];
  from: number | null;
  to: number | null;
  metrics: MetricView[];
}

const RIBBON_SLICES = 56;
// not Math.min(...list): spreading a long list overflows the call stack
const minOf = (xs: Iterable<number>) => { let m = Infinity; for (const x of xs) if (x < m) m = x; return m; };
const maxOf = (xs: Iterable<number>) => { let m = -Infinity; for (const x of xs) if (x > m) m = x; return m; };

/** What the signed readings of one version say, for the eye: per metric, hours on, the shape over time, and gaps. */
export function summarizeEvidence(v: BundleVersion): EvidenceView {
  const rs = v.evidence.readings.map((s) => s.reading);
  const from = rs.length ? minOf(rs.map((r) => r.t)) : null;
  const to = rs.length ? maxOf(rs.map((r) => r.t + r.intervalSec * 1000)) : null;
  const byMetric = new Map<string, typeof rs>();
  for (const r of rs) {
    const list = byMetric.get(r.metric);
    if (list) list.push(r);
    else byMetric.set(r.metric, [r]);
  }
  const metrics: MetricView[] = [...byMetric.entries()]
    .map(([metric, list]) => {
      const info = METRIC_LABEL[metric];
      const binary = info?.binary ?? list.every((r) => r.value === 0 || r.value === 1);
      let missing = 0;
      const perDevice = new Map<string, number[]>();
      for (const r of list) {
        const seqs = perDevice.get(r.device);
        if (seqs) seqs.push(r.seq);
        else perDevice.set(r.device, [r.seq]);
      }
      for (const seqs of perDevice.values()) {
        const unique = new Set(seqs);
        missing += maxOf(unique) - minOf(unique) + 1 - unique.size;
      }
      const m: MetricView = { metric, label: info?.label ?? metric, binary, samples: list.length, missing };
      if (binary) {
        m.activeHours = list.reduce((h, r) => h + (r.value === 1 ? r.intervalSec : 0), 0) / 3600;
        if (from !== null && to !== null && to > from) {
          const span = (to - from) / RIBBON_SLICES;
          const on = new Array<number>(RIBBON_SLICES).fill(0);
          const seen = new Array<number>(RIBBON_SLICES).fill(0);
          for (const r of list) {
            const i = Math.min(RIBBON_SLICES - 1, Math.max(0, Math.floor((r.t - from) / span)));
            seen[i] += r.intervalSec;
            if (r.value === 1) on[i] += r.intervalSec;
          }
          m.ribbon = on.map((x, i) => (seen[i] > 0 ? x / seen[i] : null));
        }
      } else {
        const vals = list.map((r) => r.value);
        m.mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        m.min = minOf(vals);
        m.max = maxOf(vals);
      }
      return m;
    })
    .sort((a, b) => Number(b.binary) - Number(a.binary) || a.label.localeCompare(b.label));
  return { version: v.version, readingCount: rs.length, devices: [...new Set(rs.map((r) => r.device))], from, to, metrics };
}
