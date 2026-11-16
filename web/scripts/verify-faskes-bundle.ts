/*
 * Check a faskes evidence bundle from the command line, the same checks as the Verifier Desk:
 *   npx tsx scripts/verify-faskes-bundle.ts <bundle.json> [--rpc http://127.0.0.1:8545]
 * Exit code 0: everything verifies. 1: a check failed. 2: the file could not be read. Without --rpc (or when the node cannot be read) only the file is
 * checked, and the ledger values it carries about itself are NOT proof of anything: the exit code then says so (3 = offline
 * checks pass, the chain was not consulted).
 */
import { readFileSync } from "node:fs";

import { parseBundle, verifyBundle, type Check } from "../src/lib/faskesVerify/bundle";
import { chainChecks, readChain } from "../src/lib/faskesVerify/chain";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--rpc");
  const rpcAt = args.indexOf("--rpc");
  const rpc = rpcAt >= 0 ? args[rpcAt + 1] : undefined;
  if (!file) {
    console.error("usage: npx tsx scripts/verify-faskes-bundle.ts <bundle.json> [--rpc <url>]");
    process.exit(2);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const parsed = parseBundle(raw);
  if (!parsed.ok) {
    console.error(`not a bundle this tool reads: ${parsed.error}`);
    process.exit(2);
  }
  const b = parsed.bundle;
  const line = (c: Check) => console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.id.padEnd(20)} ${c.detail}`);

  console.log(`claim ${b.claim.claimNo}  ${b.claim.claimId}`);
  console.log(`\nOffline, from the file alone (its own ledger values are taken as given):`);
  const offline = verifyBundle(b);
  offline.checks.forEach(line);

  let chainOk: boolean | null = null;
  let unreachable = false;
  if (rpc) {
    console.log(`\nAgainst the chain (${rpc}):`);
    const outcome = await readChain(b, rpc);
    if (!outcome.reachable) {
      // an outage is "not proven", not "bad": the same stance the Verifier Desk takes
      console.log(`  ----  chain                the node could not be read: ${outcome.reason}`);
      unreachable = true;
    } else if (!outcome.found) {
      console.log(`  FAIL  chain                ${outcome.reason}`);
      chainOk = false;
    } else {
      const result = verifyBundle(b, { values: outcome.snapshot.ledger, versionCount: outcome.snapshot.versionCount });
      const all = [...result.checks, ...chainChecks(b, outcome.snapshot)];
      all.forEach(line);
      chainOk = all.every((c) => c.ok);
    }
  }

  if (!offline.ok || chainOk === false) {
    console.log("\nRESULT: a check failed. Do not rely on this claim's evidence.");
    process.exit(1);
  }
  if (chainOk === null) {
    console.log(
      unreachable
        ? "\nRESULT: the file is internally consistent, but the chain could not be read, so the ledger values are the sender's word."
        : "\nRESULT: the file is internally consistent. The chain was not consulted (--rpc), so the ledger values are the sender's word.",
    );
    process.exit(3);
  }
  console.log("\nRESULT: every check passes, including against the chain.");
  process.exit(0);

}

void main();
