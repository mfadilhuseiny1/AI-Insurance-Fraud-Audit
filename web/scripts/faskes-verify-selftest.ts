/*
 * Proves the Verifier Desk's checks can FAIL, not only pass. Takes a good bundle exported by the faskes app and breaks it
 * in the ways a dishonest sender would; every break must be caught, and the one a file alone cannot catch (a forgery whose
 * hashes are all recomputed to agree) must be caught by the chain.
 *   npx tsx scripts/faskes-verify-selftest.ts <good-bundle.json> [--rpc http://127.0.0.1:8545]
 * Exit 0: every scenario behaved as expected. 1: the verifier missed something. Without --rpc the chain scenarios are skipped.
 */
import { readFileSync } from "node:fs";

import { parseBundle, verifyBundle, type EvidenceBundle } from "../src/lib/faskesVerify/bundle";
import { chainChecks, readChain } from "../src/lib/faskesVerify/chain";
import { forgeConsistently } from "../src/lib/faskesVerify/tamper";

type Scenario = {
  name: string;
  /** mutate a private copy of the good bundle */
  break?: (b: EvidenceBundle) => void;
  /** offline: true means the file alone must verify */
  offlineOk: boolean;
  /** which offline check must fail (when offlineOk is false) */
  offlineFails?: string;
  /** against the chain: true means every check passes; false means at least one fails; skipped without --rpc */
  chainOk?: boolean;
  chainFails?: string;
};

const scenarios: Scenario[] = [
  { name: "the bundle as exported", offlineOk: true, chainOk: true },
  { name: "one reading's value edited", break: (b) => { const r = b.versions[b.versions.length - 1].evidence.readings[3].reading; r.value = r.value === 1 ? 0 : 1; }, offlineOk: false, offlineFails: "evidence", chainOk: false, chainFails: "evidence" },
  { name: "one reading removed", break: (b) => { b.versions[b.versions.length - 1].evidence.readings.splice(5, 1); }, offlineOk: false, offlineFails: "evidence", chainOk: false, chainFails: "evidence" },
  { name: "a reading signed by another key", break: (b) => { const rs = b.versions[0].evidence.readings; rs[1].sig = rs[2].sig; }, offlineOk: false, offlineFails: "evidence", chainOk: false, chainFails: "evidence" },
  { name: "v1's claim rewritten, hashes left alone", break: (b) => { (b.versions[0].claim as Record<string, unknown>).__x = 1; }, offlineOk: false, offlineFails: "claim-hash", chainOk: false, chainFails: "claim-hash" },
  { name: "the last version left out", break: (b) => { b.versions.pop(); }, offlineOk: false, offlineFails: "versions", chainOk: false, chainFails: "versions" },
  { name: "report swapped for another version's", break: (b) => { if (b.versions.length > 1 && b.versions[0].report && b.versions[1].report) [b.versions[0].report, b.versions[1].report] = [b.versions[1].report, b.versions[0].report]; }, offlineOk: false, offlineFails: "report", chainOk: false, chainFails: "report" },
  { name: "a forgery whose every hash was recomputed", break: forgeConsistently, offlineOk: true, chainOk: false, chainFails: "ledger" },
  { name: "the contract address changed", break: (b) => { b.ledger.contract = "0x000000000000000000000000000000000000dEaD"; }, offlineOk: true, chainOk: false },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rpcAt = args.indexOf("--rpc");
  const rpc = rpcAt >= 0 ? args[rpcAt + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--rpc");
  if (!file) {
    console.error("usage: npx tsx scripts/faskes-verify-selftest.ts <good-bundle.json> [--rpc <url>]");
    process.exit(2);
  }
  const parsed = parseBundle(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.ok) {
    console.error(`not a bundle: ${parsed.error}`);
    process.exit(2);
  }
  const good = parsed.bundle;
  let wrong = 0;
  const say = (ok: boolean, name: string, what: string) => {
    if (!ok) wrong++;
    console.log(`  ${ok ? "ok  " : "MISS"}  ${name.padEnd(46)} ${what}`);
  };

  for (const s of scenarios) {
    const b = structuredClone(good);
    s.break?.(b);
    const offline = verifyBundle(b);
    const offFailed = offline.checks.filter((c) => !c.ok);
    const wantOff = s.offlineFails;
    const offExpected = s.offlineOk ? offline.ok : !offline.ok && (!wantOff || offFailed.some((c) => c.id === wantOff || c.detail.includes(wantOff)));
    say(offExpected, s.name, s.offlineOk ? `offline: ${offline.ok ? "verifies" : "FAILS (" + offFailed.map((c) => c.id).join(",") + ")"}` : `offline: ${offline.ok ? "NOT CAUGHT" : "caught (" + offFailed.map((c) => c.id).join(",") + ")"}`);

    if (rpc && s.chainOk !== undefined) {
      const outcome = await readChain(b, rpc);
      let all: { id: string; ok: boolean; detail: string }[];
      let reached = true;
      if (outcome.reachable && outcome.found) {
        const r = verifyBundle(b, { values: outcome.snapshot.ledger, versionCount: outcome.snapshot.versionCount });
        all = [...r.checks, ...chainChecks(b, outcome.snapshot)];
      } else {
        reached = outcome.reachable;
        all = [{ id: "chain", ok: false, detail: outcome.reachable ? outcome.reason : outcome.reason }];
      }
      const failed = all.filter((c) => !c.ok);
      const ok = all.every((c) => c.ok);
      const wantChain = s.chainFails;
      const expected = s.chainOk ? ok : !ok && (!wantChain || failed.some((c) => c.id === wantChain || c.detail.includes(wantChain)));
      say(expected && (s.chainOk || reached), "", `chain:   ${ok ? "verifies" : (s.chainOk ? "FAILS" : "caught") + " (" + failed.map((c) => c.id).join(",") + ")"}`);
    }
  }
  if (!rpc) console.log("\n  (chain scenarios skipped: pass --rpc to include them)");
  console.log(wrong === 0 ? "\nEvery scenario behaved as expected." : `\n${wrong} scenario(s) behaved unexpectedly: the verifier missed something.`);
  process.exit(wrong === 0 ? 0 : 1);
}

void main();
