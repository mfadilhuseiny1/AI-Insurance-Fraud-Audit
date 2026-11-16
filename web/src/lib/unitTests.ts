/**
 * Unit tests: run some of a pipeline's transform nodes on manually entered test inputs and compare what
 * they produce with expected outputs. Inputs are the references that feed the tested nodes from outside
 * them; outputs are the tested nodes no other tested node reads. Rows are compared as multisets (order
 * does not matter); for streaming pipelines the `ordering` column of the inputs sets the order rows are
 * fed in, and is not part of the data.
 */
import {
  castCell,
  evaluator,
  inputsOf,
  refLabel,
  refNode,
  remapInputs,
  type Cell,
  type Column,
  type Pipeline,
  type PipelineNode,
  type SqlRuntime,
  type Table,
  type UnitTest,
  type UnitTestTable,
} from "./pipeline";

export const ORDERING = "ordering";

/** The refs feeding the tested nodes from outside, and the tested nodes whose output is checked. */
export function testShape(p: Pick<Pipeline, "nodes">, nodeIds: string[]): { inputs: string[]; outputs: string[] } {
  const set = new Set(nodeIds);
  const tested = p.nodes.filter((n) => set.has(n.id));
  const inputs = [...new Set(tested.flatMap((n) => inputsOf(n).filter((r) => r && !set.has(refNode(r)))))];
  const outputs = tested.filter((n) => !tested.some((m) => inputsOf(m).some((r) => refNode(r) === n.id))).map((n) => n.id);
  return { inputs, outputs };
}

/** Nodes added between tested nodes join the test (the doc: they show up in the existing test automatically). */
export function withNodesBetween(p: Pick<Pipeline, "nodes">, nodeIds: string[]): string[] {
  const set = new Set(nodeIds);
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const n = byId.get(from);
    return !!n && inputsOf(n).some((r) => reaches(refNode(r), to, seen));
  };
  const extra = p.nodes.filter((n) => !set.has(n.id) && nodeIds.some((a) => reaches(a, n.id)) && nodeIds.some((b) => reaches(n.id, b)));
  return [...nodeIds, ...extra.map((n) => n.id)];
}

const canon = (v: Cell, col: Column | undefined) => {
  if (v === null || v === undefined || v === "") return "\u0000";
  const c = col ? castCell(v, col.type) : v;
  return typeof c === "number" ? String(Math.round(c * 1e9) / 1e9) : String(c);
};

/** Expected vs received: same columns and the same rows in any order. */
export function compareTables(expected: UnitTestTable, received: Table): { ok: boolean; message: string; missing: number; extra: number } {
  const exp = expected.columns.map((c) => c.name);
  const got = received.columns.map((c) => c.name);
  const missingCols = exp.filter((c) => !got.includes(c));
  const extraCols = got.filter((c) => !exp.includes(c));
  if (missingCols.length || extraCols.length)
    return {
      ok: false,
      message: [missingCols.length ? `missing column${missingCols.length > 1 ? "s" : ""} ${missingCols.join(", ")}` : "", extraCols.length ? `unexpected column${extraCols.length > 1 ? "s" : ""} ${extraCols.join(", ")}` : ""].filter(Boolean).join("; "),
      missing: 0,
      extra: 0,
    };
  const key = (r: Record<string, Cell>) => exp.map((c) => canon(r[c] ?? null, expected.columns.find((x) => x.name === c))).join("\u0001");
  const want = new Map<string, number>();
  for (const r of expected.rows) want.set(key(r), (want.get(key(r)) ?? 0) + 1);
  let extra = 0;
  for (const r of received.rows) {
    const k = key(r);
    const n = want.get(k) ?? 0;
    if (n > 0) want.set(k, n - 1);
    else extra++;
  }
  const missing = [...want.values()].reduce((a, b) => a + b, 0);
  const ok = !missing && !extra;
  return { ok, missing, extra, message: ok ? `${received.rows.length} rows match` : `${missing} expected row${missing === 1 ? "" : "s"} not received, ${extra} unexpected row${extra === 1 ? "" : "s"}` };
}

export type TestRun = { ok: boolean; results: { node: string; ok: boolean; message: string; received?: Table; expected?: UnitTestTable }[] };

export function runUnitTest(p: Pipeline, test: UnitTest, sql?: SqlRuntime): TestRun {
  const nodeIds = withNodesBetween(p, test.nodes);
  const { inputs, outputs } = testShape(p, nodeIds);
  const streaming = p.type === "streaming";
  // stand-ins for the inputs: InputNodes fed the test data
  const stand = new Map(inputs.map((ref, i) => [ref, `__test_input_${i}`]));
  const tableFor = (ref: string): Table | undefined => {
    const t = test.inputs[ref];
    if (!t) return undefined;
    let rows = t.rows;
    if (streaming && t.columns.some((c) => c.name === ORDERING)) rows = [...rows].sort((a, b) => Number(a[ORDERING] ?? 0) - Number(b[ORDERING] ?? 0));
    const columns = t.columns.filter((c) => !(streaming && c.name === ORDERING));
    return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c.name, castCell(r[c.name] ?? null, c.type)]))) };
  };
  const results: TestRun["results"] = [];
  const missingInputs = inputs.filter((r) => !test.inputs[r]);
  if (missingInputs.length)
    return { ok: false, results: [{ node: "", ok: false, message: `Fill in the test input${missingInputs.length > 1 ? "s" : ""} ${missingInputs.map((r) => refLabel(p.nodes, r)).join(", ")}` }] };
  const nodes: PipelineNode[] = [
    ...inputs.map((ref, i): PipelineNode => ({ id: stand.get(ref)!, kind: "input", name: refLabel(p.nodes, ref), inputId: `in${i}`, x: 0, y: 0 })),
    ...p.nodes.filter((n) => nodeIds.includes(n.id)).map((n) => remapInputs(n, (r) => stand.get(r) ?? r)),
  ];
  const ev = evaluator({ nodes, datasets: p.datasets, parameters: p.parameters, functions: p.functions, subgraphs: p.subgraphs }, sql, {
    inputs: Object.fromEntries(inputs.map((ref, i) => [`in${i}`, tableFor(ref)!])),
  });
  for (const id of outputs) {
    const expected = test.expected[id];
    const r = ev(id);
    const name = p.nodes.find((n) => n.id === id)?.name ?? id;
    if (r.error !== undefined) results.push({ node: id, ok: false, message: `${name}: ${r.error}`, expected });
    else if (!expected) results.push({ node: id, ok: false, message: `${name}: fill in the expected output`, received: r.table });
    else {
      const c = compareTables(expected, r.table);
      results.push({ node: id, ok: c.ok, message: `${name}: ${c.message}`, received: r.table, expected });
    }
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}
