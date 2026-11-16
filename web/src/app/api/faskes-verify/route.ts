import { chainChecks, readChain, type ChainOutcome } from "@/lib/faskesVerify/chain";
import { parseBundle, summarizeEvidence, verifyBundle, type BundleResult, type EvidenceView } from "@/lib/faskesVerify/bundle";
import { TAMPER_MODES, applyTamper, type TamperMode } from "@/lib/faskesVerify/tamper";
import { signedIn } from "@/lib/sessionCheck";

/*
 * The Verifier Desk's check of a faskes evidence bundle (the file the faskes app exports for one claim).
 *   POST  the bundle as JSON  ->  { claim, offline, onchain, evidence }
 *         ?tamper=reading|claim|forge  breaks the in-memory copy first, to show the checks catching it (a demonstration;
 *         the file you sent is never changed)
 *     offline   every hash, signature, link and report of every version, using only the file
 *     onchain   the same checks against what the CHAIN holds for this claim (the file's own copy of the ledger is not
 *               trusted), plus device registration and commit-before-claim timing; absent when the chain cannot be reached
 *     evidence  what the signed readings of each version show, for the page to draw
 * Read-only: nothing is stored and no transaction is sent. The bundle holds synthetic faskes data only; BPJS claim
 * data never enters this route. Signed-in users only (the API says who is signed in).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC = process.env.FASKES_RPC_URL ?? "http://127.0.0.1:8545";
const MAX_BYTES = 40 * 1024 * 1024;
// signature recovery is CPU work on this server's one thread: a couple at a time is plenty for a desk
const MAX_PARALLEL = 2;
let running = 0;

export async function POST(request: Request) {
  if (!(await signedIn(request))) return Response.json({ error: "Sign in to use the Verifier Desk." }, { status: 401 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return Response.json({ error: "The file is larger than 40 MB." }, { status: 413 });
  if (running >= MAX_PARALLEL) return Response.json({ error: "Two checks are already running. Try again in a moment." }, { status: 429 });

  running++;
  try {
    const text = await request.text();
    if (text.length > MAX_BYTES) return Response.json({ error: "The file is larger than 40 MB." }, { status: 413 });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return Response.json({ error: "The file is not valid JSON." }, { status: 400 });
    }
    const parsed = parseBundle(raw);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const b = parsed.bundle;
    const mode = new URL(request.url).searchParams.get("tamper");
    const tamper = TAMPER_MODES.includes(mode as TamperMode) ? (mode as TamperMode) : null;
    if (tamper) applyTamper(b, tamper);

    const offline: BundleResult = verifyBundle(b);
    const outcome: ChainOutcome = await readChain(b, RPC);
    let onchain: { outcome: ChainOutcome; result?: BundleResult } = { outcome };
    if (outcome.reachable && outcome.found) {
      const s = outcome.snapshot;
      const result = verifyBundle(b, { values: s.ledger, versionCount: s.versionCount });
      result.checks.push(...chainChecks(b, s));
      result.ok = result.checks.every((c) => c.ok);
      onchain = { outcome, result };
    }
    const evidence: EvidenceView[] = b.versions.map(summarizeEvidence);
    return Response.json(
      {
        claim: b.claim,
        tamper,
        bundle: { generatedAt: b.generatedAt, contract: b.ledger.contract, chainId: b.ledger.chainId ?? null, statusWhenExported: b.ledger.status, devices: b.devices },
        versions: b.versions.map((v) => ({ version: v.version, submittedAt: v.manifest.submittedAt, readingCount: v.manifest.readingCount, versionHash: v.manifest.versionHash, previousVersionHash: v.manifest.previousVersionHash, hasReport: Boolean(v.report), verdictInBundle: v.report?.verdict ?? null })),
        offline,
        onchain,
        evidence,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 300) : "The check failed." }, { status: 500 });
  } finally {
    running--;
  }
}
