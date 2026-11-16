"use client";

/** Quiver object set cards (api/quiver_cards.py): filter object set (properties, a linked object's properties,
 * nested and / or groups), set math, switch to linked object set, status filter, object view, defined by property and
 * import saved object set — their settings and what they show. Each card is itself an object set that tables, charts,
 * single cards and other object set cards read. */
import { useEffect, useState } from "react";
import { ontology } from "@/lib/ontology";
import {
  cellText,
  isConditionGroup,
  OBJECT_FILTER_OPS,
  OBJECT_INPUT_KINDS,
  quiverTables,
  SET_MATH_OPS,
  type ObjectCondition,
  type ObjectFilterOp,
  type ObjectProperty,
  type ObjectSetSingleCard,
  type SavedObjectSet,
  type TableResult,
} from "@/lib/quiverTables";
import { RangeSelect, type OperandField } from "@/components/quiver/SeriesCards";

const field = "rounded border border-line-2 bg-panel px-1.5 py-1 text-[11px] text-soft outline-none focus:border-blue-500";
type Ref = { id: string; title: string; kind: string };
type Leaf = Extract<ObjectCondition, { property: string }>;
type Group = Extract<ObjectCondition, { conditions: ObjectCondition[] }>;
type Link = NonNullable<TableResult["links"]>[number];

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-muted">{text}</span>
      {children}
    </label>
  );
}

/** An object set input: an object set card, an object selector or another object set card. */
function ObjectInput({ value, refs, onChange, label = "Object set", exclude }: { value: string; refs: Ref[]; onChange: (v: string) => void; label?: string; exclude?: string }) {
  const sets = refs.filter((x) => (OBJECT_INPUT_KINDS as readonly string[]).includes(x.kind) && x.id !== exclude);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-full`} aria-label={label}>
      <option value="">{sets.length ? `${label}…` : "Add an object set first (Objects, above)"}</option>
      {value && !sets.some((x) => x.id === value) && <option value={value}>${value}</option>}
      {sets.map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}
    </select>
  );
}

/** The input's properties (display names when the type is known, else the input's columns). */
function inputProperties(r?: TableResult): ObjectProperty[] {
  const props = r?.input_type?.properties;
  if (props?.length) return props;
  return Object.keys(r?.column_types ?? {}).filter((c) => c !== "primary_key").map((c) => ({ api_name: c, display_name: c, type: r?.column_types?.[c] }));
}

/** The [property | linked property] picker of a condition: "p:<api>", "l:<link>|<api>", "l:<link>|" (any linked object). */
function targetOf(c: Leaf): string {
  return c.link ? `l:${c.link}|${c.property ?? ""}` : c.property ? `p:${c.property}` : "";
}

function ConditionRow({ c, props, links, operand, onChange, onRemove, path }: {
  c: Leaf; props: ObjectProperty[]; links: Link[]; operand: OperandField; onChange: (c: Leaf) => void; onRemove: () => void; path: string;
}) {
  const target = targetOf(c);
  const anyLink = !!c.link && !c.property;
  const opInfo = OBJECT_FILTER_OPS.find((o) => o[0] === c.op);
  const pick = (v: string) => {
    if (v.startsWith("l:")) {
      const [link, prop] = v.slice(2).split("|");
      onChange({ link, property: prop ?? "", op: prop ? (c.op === "linked" || c.op === "not_linked" ? "eq" : c.op) : "linked", value: prop ? c.value : undefined });
    } else onChange({ property: v.slice(2), op: c.op === "linked" || c.op === "not_linked" ? "eq" : c.op, value: c.value });
  };
  return (
    <div className="flex flex-wrap items-start gap-1 rounded border border-line bg-panel-2/40 p-1" data-testid={`condition-${path}`}>
      <select value={target} onChange={(e) => pick(e.target.value)} className={`${field} min-w-0 flex-[2]`} aria-label={`Condition ${path}: property`}>
        <option value="">Property…</option>
        {target && !target.startsWith("l:") && !props.some((p) => `p:${p.api_name}` === target) && <option value={target}>{target.slice(2)}</option>}
        <optgroup label="Properties">{props.map((p) => <option key={p.api_name} value={`p:${p.api_name}`}>{p.display_name}{p.type ? ` (${p.type})` : ""}</option>)}</optgroup>
        {links.map((l) => (
          <optgroup key={l.link} label={`Linked: ${l.label}`}>
            <option value={`l:${l.link}|`}>{l.object_type}: any linked object</option>
            {l.properties.map((p) => <option key={p.api_name} value={`l:${l.link}|${p.api_name}`}>{l.object_type}: {p.display_name}</option>)}
          </optgroup>
        ))}
        {target.startsWith("l:") && !links.some((l) => target.startsWith(`l:${l.link}|`)) && <option value={target}>{target.slice(2)}</option>}
      </select>
      <select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as ObjectFilterOp })} className={`${field} min-w-0 flex-1`} aria-label={`Condition ${path}: operator`}>
        {anyLink ? (
          <>
            <option value="linked">has a linked object</option>
            <option value="not_linked">has no linked object</option>
          </>
        ) : OBJECT_FILTER_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {!anyLink && opInfo?.[2] && <div className="min-w-[8rem] flex-[2]">{operand(c.value ?? "", (v) => onChange({ ...c, value: v }), c.op === "between" ? "from, to" : c.op === "in" ? "a, b, c" : "value", `Condition ${path}: value`)}</div>}
      <button type="button" onClick={onRemove} className="px-1 text-muted hover:text-bad" aria-label={`Remove condition ${path}`}>×</button>
    </div>
  );
}

/** A list of conditions joined by all (and) / any (or); groups nest. */
function ConditionGroup({ g, props, links, operand, onChange, onRemove, path, depth }: {
  g: Group; props: ObjectProperty[]; links: Link[]; operand: OperandField; onChange: (g: Group) => void; onRemove?: () => void; path: string; depth: number;
}) {
  const set = (i: number, c: ObjectCondition) => onChange({ ...g, conditions: g.conditions.map((x, j) => (j === i ? c : x)) });
  const drop = (i: number) => onChange({ ...g, conditions: g.conditions.filter((_, j) => j !== i) });
  return (
    <div className={`space-y-1 ${depth ? "rounded border border-dashed border-line-2 p-1.5" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted">{depth ? "Group: match" : "Match"}</span>
        <select value={g.match} onChange={(e) => onChange({ ...g, match: e.target.value as Group["match"] })} className={field} aria-label={depth ? `Group ${path}: match` : "Match"}>
          <option value="all">all conditions (and)</option>
          <option value="any">any condition (or)</option>
        </select>
        {depth > 0 && <label className="flex items-center gap-1"><input type="checkbox" checked={!!g.negate} onChange={(e) => onChange({ ...g, negate: e.target.checked })} />not</label>}
        {onRemove && <button type="button" onClick={onRemove} className="ml-auto px-1 text-muted hover:text-bad" aria-label={`Remove group ${path}`}>×</button>}
      </div>
      {g.conditions.map((c, i) => isConditionGroup(c) ? (
        <ConditionGroup key={i} g={c} props={props} links={links} operand={operand} onChange={(x) => set(i, x)} onRemove={() => drop(i)} path={`${path}.${i + 1}`} depth={depth + 1} />
      ) : (
        <ConditionRow key={i} c={c} props={props} links={links} operand={operand} onChange={(x) => set(i, x)} onRemove={() => drop(i)} path={`${path}.${i + 1}`} />
      ))}
      <div className="flex gap-3">
        <button type="button" onClick={() => onChange({ ...g, conditions: [...g.conditions, { property: "", op: "eq", value: "" }] })} className="text-blue-700 hover:underline">+ Condition</button>
        {depth < 4 && <button type="button" onClick={() => onChange({ ...g, conditions: [...g.conditions, { match: g.match === "all" ? "any" : "all", conditions: [{ property: "", op: "eq", value: "" }] }] })} className="text-blue-700 hover:underline">+ Nested group</button>}
      </div>
    </div>
  );
}

let typesCache: Promise<{ id: string; display_name: string }[]> | null = null;

/** The saved object sets the viewer can import (loaded when a card needs them). */
function useSavedSets(need: boolean): { sets: SavedObjectSet[]; error: string | null } {
  const [state, setState] = useState<{ sets: SavedObjectSet[]; error: string | null }>({ sets: [], error: null });
  useEffect(() => {
    if (!need) return;
    let live = true;
    quiverTables.savedObjectSets().then((sets) => { if (live) setState({ sets, error: null }); }, (e: Error) => { if (live) setState({ sets: [], error: e.message }); });
    return () => { live = false; };
  }, [need]);
  return state;
}

/** A saved object set picker: explorations and object lists, by RID. */
function SavedSetSelect({ value, sets, onChange, label, placeholder = "Saved object set…" }: { value: string; sets: SavedObjectSet[]; onChange: (s: SavedObjectSet | null, rid: string) => void; label: string; placeholder?: string }) {
  const group = (kind: SavedObjectSet["kind"]) => sets.filter((x) => x.kind === kind);
  const name = (x: SavedObjectSet) => `${x.name} · ${x.object_type ?? "?"}${x.count !== undefined ? ` · ${x.count.toLocaleString()}` : ""}`;
  return (
    <select value={value} onChange={(e) => onChange(sets.find((x) => x.rid === e.target.value) ?? null, e.target.value)} className={`${field} w-full`} aria-label={label}>
      <option value="">{sets.length ? placeholder : "No saved object sets (save one in Object Explorer, or with Save as object list)"}</option>
      {value && !sets.some((x) => x.rid === value) && <option value={value}>{value}</option>}
      {group("exploration").length > 0 && <optgroup label="Object Explorer explorations">{group("exploration").map((x) => <option key={x.rid} value={x.rid}>{name(x)}</option>)}</optgroup>}
      {group("list").length > 0 && <optgroup label="Object lists">{group("list").map((x) => <option key={x.rid} value={x.rid}>{name(x)}</option>)}</optgroup>}
    </select>
  );
}

/** The settings of an object set card. `operand`: a typed value, a card's value or a parameter ($ID). */
export function ObjectCardForm({ card, r, refs, params, operand, onChange }: {
  card: ObjectSetSingleCard; r?: TableResult; refs: Ref[]; params: string[]; operand: OperandField; onChange: (p: Partial<ObjectSetSingleCard>) => void;
}) {
  const [types, setTypes] = useState<{ id: string; display_name: string }[]>([]);
  const needTypes = (card.kind === "object_view" || card.kind === "defined_by_property") && !card.source;
  const saved = useSavedSets(card.kind === "saved_object_set" || (card.kind === "defined_by_property" && !card.from));
  useEffect(() => {
    if (!needTypes) return;
    typesCache ??= ontology.objectTypes().catch(() => { typesCache = null; return []; });
    let live = true;
    void typesCache.then((t) => { if (live) setTypes(t); });
    return () => { live = false; };
  }, [needTypes]);
  const links = r?.links ?? [];
  const props = inputProperties(r);
  switch (card.kind) {
    case "filter_object_set":
      return (
        <>
          <ObjectInput value={card.source.card} refs={refs} onChange={(v) => onChange({ source: { card: v } })} />
          <ConditionGroup g={{ match: card.match ?? "all", conditions: card.conditions }} props={props} links={links} operand={operand} onChange={(g) => onChange({ match: g.match, conditions: g.conditions })} path="1" depth={0} />
        </>
      );
    case "set_math": {
      const t = r?.input_types ?? {};
      const first = card.inputs[0] ? t[card.inputs[0]] : undefined;
      return (
        <>
          <Label text="Operation">
            <select value={card.op} onChange={(e) => onChange({ op: e.target.value as typeof card.op })} className={`${field} w-full`} aria-label="Set operation">
              {SET_MATH_OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Label>
          <div className="space-y-1">
            {card.inputs.map((x, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-4 text-right text-muted">{i + 1}</span>
                <div className="min-w-0 flex-1"><ObjectInput value={x} refs={refs} exclude={card.id} label={`Object set ${i + 1}`} onChange={(v) => onChange({ inputs: card.inputs.map((y, j) => (j === i ? v : y)) })} /></div>
                {first && t[x] && t[x] !== first && <span className="text-bad" title="Set math combines object sets of the same type">≠ type</span>}
                {card.inputs.length > 2 && <button type="button" onClick={() => onChange({ inputs: card.inputs.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label={`Remove object set ${i + 1}`}>×</button>}
              </div>
            ))}
            {card.inputs.length < 10 && <button type="button" onClick={() => onChange({ inputs: [...card.inputs, ""] })} className="text-blue-700 hover:underline">+ Add object set</button>}
          </div>
        </>
      );
    }
    case "linked_object_set":
      return (
        <>
          <ObjectInput value={card.source.card} refs={refs} onChange={(v) => onChange({ source: { card: v }, link: "" })} />
          <Label text="Link to follow">
            <select value={card.link} onChange={(e) => onChange({ link: e.target.value, ...(card.title === "Linked object set" || links.some((l) => l.object_type === card.title) ? { title: links.find((l) => l.link === e.target.value)?.object_type ?? card.title } : {}) })} className={`${field} w-full`} aria-label="Link">
              <option value="">{links.length || !card.source.card ? "Link…" : "The input's type has no links"}</option>
              {card.link && !links.some((l) => l.link === card.link) && <option value={card.link}>{card.link}</option>}
              {links.map((l) => <option key={l.link} value={l.link}>{l.label}</option>)}
            </select>
          </Label>
        </>
      );
    case "status_filter": {
      const dates = props.filter((p) => r?.column_types?.[p.api_name] === "date");
      const pickDate = (value: string, set: (v: string) => void, label: string) => (
        <select value={value} onChange={(e) => set(e.target.value)} className={`${field} w-full`} aria-label={label}>
          <option value="">Date property…</option>
          {value && !dates.some((p) => p.api_name === value) && <option value={value}>{value}</option>}
          {dates.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}</option>)}
        </select>
      );
      return (
        <>
          <ObjectInput value={card.source.card} refs={refs} onChange={(v) => onChange({ source: { card: v } })} />
          <div className="grid grid-cols-2 gap-2">
            <Label text="Start (opened)">{pickDate(card.start_property, (v) => onChange({ start_property: v }), "Start date property")}</Label>
            <Label text="End (closed)">{pickDate(card.end_property, (v) => onChange({ end_property: v }), "End date property")}</Label>
          </div>
          <Label text="Status during the range">
            <select value={card.status} onChange={(e) => onChange({ status: e.target.value as "open" | "closed" })} className={`${field} w-full`} aria-label="Status">
              <option value="open">Open (opened before its end, not closed by it)</option>
              <option value="closed">Closed (closed during it)</option>
            </select>
          </Label>
          <RangeSelect value={card.range} refs={refs} params={params} onChange={(v) => onChange({ range: v })} fullLabel="All time" />
        </>
      );
    }
    case "object_view": {
      const byCard = !!card.source;
      return (
        <>
          <div className="flex gap-3">
            <label className="flex items-center gap-1"><input type="radio" checked={byCard} onChange={() => onChange({ source: { card: "" }, object_type_id: undefined, primary_key: undefined })} />From an object set</label>
            <label className="flex items-center gap-1"><input type="radio" checked={!byCard} onChange={() => onChange({ source: undefined, primary_key: "" })} />By type and key</label>
          </div>
          {byCard ? (
            <ObjectInput value={card.source?.card ?? ""} refs={refs} onChange={(v) => onChange({ source: { card: v } })} label="Object set holding one object" />
          ) : (
            <>
              <Label text="Object type (empty: from the key's card, e.g. a backing object)">
                <select value={card.object_type_id ?? ""} onChange={(e) => onChange({ object_type_id: e.target.value || undefined })} className={`${field} w-full`} aria-label="Object type">
                  <option value="">Object type…</option>
                  {card.object_type_id && !types.some((t) => t.id === card.object_type_id) && <option value={card.object_type_id}>{r?.object_type ?? card.object_type_id}</option>}
                  {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                </select>
              </Label>
              <Label text="Primary key">{operand(card.primary_key ?? "", (v) => onChange({ primary_key: v }), "RS-01", "Primary key")}</Label>
            </>
          )}
        </>
      );
    }
    case "defined_by_property": {
      const byCard = !!card.source;
      const fromCard = !!card.from;
      const fromTypes = r?.from_column_types ?? {};
      const others = refs.filter((x) => x.id !== card.id);
      return (
        <>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-1"><input type="radio" checked={byCard} onChange={() => onChange({ source: { card: "" }, object_type_id: undefined })} />Objects of an object set</label>
            <label className="flex items-center gap-1"><input type="radio" checked={!byCard} onChange={() => onChange({ source: undefined, object_type_id: r?.object_type_id ?? "" })} />Every object of a type</label>
          </div>
          {byCard ? (
            <ObjectInput value={card.source?.card ?? ""} refs={refs} exclude={card.id} onChange={(v) => onChange({ source: { card: v } })} />
          ) : (
            <select value={card.object_type_id ?? ""} onChange={(e) => onChange({ object_type_id: e.target.value })} className={`${field} w-full`} aria-label="Object type">
              <option value="">Object type…</option>
              {card.object_type_id && !types.some((t) => t.id === card.object_type_id) && <option value={card.object_type_id}>{r?.object_type ?? card.object_type_id}</option>}
              {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
            </select>
          )}
          <Label text="Property holding the values">
            <select value={card.property} onChange={(e) => onChange({ property: e.target.value })} className={`${field} w-full`} aria-label="Property">
              <option value="">Property…</option>
              <option value="primary_key">Primary key</option>
              {card.property && card.property !== "primary_key" && !props.some((p) => p.api_name === card.property) && <option value={card.property}>{card.property}</option>}
              {props.map((p) => <option key={p.api_name} value={p.api_name}>{p.display_name}{p.type ? ` (${p.type}${r?.array_properties?.includes(p.api_name) ? " array" : ""})` : ""}</option>)}
            </select>
            {r?.array_properties?.includes(card.property) && <span className="mt-0.5 block text-[10px] text-muted" data-testid="array-note">An array: an object matches when any element holds one of the values.</span>}
          </Label>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-1"><input type="radio" checked={fromCard} onChange={() => onChange({ from: { card: "", property: "" }, value: undefined })} />Values of another card</label>
            <label className="flex items-center gap-1"><input type="radio" checked={!fromCard} onChange={() => onChange({ from: undefined, value: "" })} />Typed values / $ID</label>
          </div>
          {fromCard ? (
            <div className="grid grid-cols-2 gap-2">
              <Label text="Card">
                <select value={card.from?.card ?? ""} onChange={(e) => onChange({ from: { card: e.target.value, property: "" } })} className={`${field} w-full`} aria-label="Values card">
                  <option value="">Card…</option>
                  {card.from?.card && !others.some((x) => x.id === card.from?.card) && <option value={card.from.card}>${card.from.card}</option>}
                  {others.map((x) => <option key={x.id} value={x.id}>${x.id} · {x.title}</option>)}
                </select>
              </Label>
              <Label text="Its column / property">
                <select value={card.from?.property ?? ""} onChange={(e) => onChange({ from: { card: card.from?.card ?? "", property: e.target.value } })} className={`${field} w-full`} aria-label="Values column">
                  <option value="">{"(the card's value: an array)"}</option>
                  {card.from?.property && !(card.from.property in fromTypes) && <option value={card.from.property}>{card.from.property}</option>}
                  {Object.keys(fromTypes).map((k) => <option key={k} value={k}>{k === "primary_key" ? "Primary key" : k} ({r?.from_array_properties?.includes(k) ? "array: each element" : fromTypes[k]})</option>)}
                </select>
              </Label>
            </div>
          ) : (
            <>
              <Label text="Values (a, b, c) or $ID">{operand(card.value ?? "", (v) => onChange({ value: v }), "a, b, c", "Values")}</Label>
              <Label text="Or a saved object set's identifier (cohorts tagged with it)">
                <SavedSetSelect value={saved.sets.some((x) => x.rid === card.value) ? card.value ?? "" : ""} sets={saved.sets} onChange={(_, rid) => onChange({ value: rid })} label="Saved object set identifier" placeholder="Use a saved object set's identifier…" />
              </Label>
            </>
          )}
        </>
      );
    }
    case "saved_object_set": {
      const pick = (x: SavedObjectSet | null, rid: string) => onChange({ object_set: rid, ...(x && (card.title === "Import saved object set" || saved.sets.some((y) => y.name === card.title)) ? { title: x.name } : {}) });
      return (
        <>
          <Label text="Saved object set">
            <SavedSetSelect value={card.object_set} sets={saved.sets} onChange={pick} label="Saved object set" />
          </Label>
          {saved.error && <p className="text-bad">{saved.error}</p>}
          <Label text="Or its identifier (RID)">
            <input value={card.object_set} onChange={(e) => onChange({ object_set: e.target.value.trim() })} placeholder="ri.object-set.main.exploration.…" className={`${field} w-full font-mono`} aria-label="Saved object set RID" />
          </Label>
        </>
      );
    }
  }
}

/** Save an object set card's objects (the saved analysis' card) as an object list another analysis imports. */
export function SaveObjectList({ aid, cardId, title }: { aid: string; cardId: string; title: string }) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    if (!name?.trim()) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await quiverTables.saveObjectList(aid, cardId, { name: name.trim() });
      setNote({ ok: true, text: `Saved "${r.name}": ${r.count.toLocaleString()} objects (${r.rid})` });
      setName(null);
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1 text-[10px]">
      {name === null ? (
        <button type="button" onClick={() => { setName(title); setNote(null); }} className="text-blue-700 hover:underline" title="The saved card's objects, as an object list other analyses import (Import saved object set)">Save as object list</button>
      ) : (
        <>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setName(null); }} className={`${field} w-44`} aria-label="Object list name" autoFocus />
          <button type="button" disabled={busy || !name.trim()} onClick={() => void save()} className="rounded bg-blue-600 px-1.5 py-0.5 text-white disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
          <button type="button" onClick={() => setName(null)} className="text-muted hover:text-soft">Cancel</button>
        </>
      )}
      {note && <span className={note.ok ? "text-good" : "text-bad"} data-testid="save-object-list-note">{note.text}</span>}
    </span>
  );
}

// arrays as "a, b", structs as "field: value" (cellText); empty values (and empty arrays) as —
const show = (v: unknown): string => (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) ? "—" : cellText(v));

const PAGE = 50;

/** An imported saved object set's details: its name, kind, type, description, owner, dates and RID. */
function SavedSetInfo({ s, total }: { s: NonNullable<TableResult["saved"]>; total: number }) {
  return (
    <div className="space-y-0.5 rounded border border-line bg-panel-2/40 p-1.5 text-[10px]" data-testid="saved-set-info">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-[11px] font-medium text-white">{s.name}</span>
        <span className="text-muted">{s.kind === "exploration" ? "Object Explorer exploration" : "Object list"}</span>
      </div>
      {s.description && <p className="text-soft">{s.description}</p>}
      <p className="text-muted">
        {s.owner ? `Saved by ${s.owner}` : "Saved"}{s.updated_at ? ` · ${String(s.updated_at).slice(0, 16).replace("T", " ")}` : ""}
        {s.stored !== total ? ` · ${s.stored.toLocaleString()} saved, ${total.toLocaleString()} visible to you` : ""}
      </p>
      <p className="truncate font-mono text-muted" title={s.rid}>{s.rid}</p>
    </div>
  );
}

/** An object set card's objects (a few columns: the title first; 50 a page when the result carries more, as a report
 * widget's 1,000 — printed all at once) or an object view's properties. */
export function ObjectSetView({ card, r, compact = false }: { card: ObjectSetSingleCard; r?: TableResult; compact?: boolean }) {
  const [page, setPage] = useState(0);
  if (!r) return <p className="text-xs text-muted">Computing…</p>;
  if (r.error) return <p className="text-xs text-bad">{r.error}</p>;
  const props = r.properties ?? [];
  const name = (api: string) => props.find((p) => p.api_name === api)?.display_name ?? api;
  if (card.kind === "object_view") {
    const row = r.object_row;
    if (!row) return <p className="text-xs text-muted">No object: the input is empty.</p>;
    return (
      <div className="space-y-1.5" data-testid="object-view">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold text-white">{r.label ?? String(row.primary_key)}</span>
          <span className="text-[11px] text-muted">{r.object_type} · {String(row.primary_key)}</span>
        </div>
        <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          {Object.keys(row).filter((k) => k !== "primary_key").slice(0, compact ? 8 : 40).map((k) => (
            <div key={k} className="contents">
              <dt className="truncate text-muted" title={k}>{name(k)}</dt>
              <dd className="truncate text-soft" title={show(row[k])}>{show(row[k])}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  const rows = r.rows ?? [];
  const title = r.title_property && r.columns?.includes(r.title_property) ? r.title_property : null;
  const cols = [title ?? "primary_key", ...(r.columns ?? []).filter((c) => c !== "primary_key" && c !== title && props.find((p) => p.api_name === c)?.type !== "vector")].slice(0, compact ? 4 : 6);
  const total = r.total ?? rows.length;
  const size = compact ? 10 : PAGE;
  const pages = compact ? 1 : Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(page, pages - 1);
  const from = at * size;
  const upto = Math.min(rows.length, from + size);
  return (
    <div className="space-y-1.5">
      {r.saved && <SavedSetInfo s={r.saved} total={total} />}
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-white" data-testid="object-count">{total.toLocaleString()}</span>
        <span className="text-xs text-muted">{r.object_type ?? "objects"}{total === 1 ? " object" : " objects"}</span>
      </div>
      {rows.length > 0 && (
        <div className="max-h-64 overflow-auto rounded border border-line print:max-h-none print:overflow-visible">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-panel-2 text-left text-muted">
              <tr>{cols.map((c) => <th key={c} className="px-1.5 py-1 font-medium">{c === "primary_key" ? "Primary key" : name(c)}</th>)}</tr>
            </thead>
            <tbody>
              {(compact ? rows.slice(0, size) : rows).map((row, i) => (
                // every row is printed; on screen one page at a time
                <tr key={i} className={`border-t border-line ${i >= from && i < upto ? "" : "hidden print:table-row"}`} data-testid="object-row">{cols.map((c) => <td key={c} className="max-w-[14rem] truncate px-1.5 py-0.5 text-soft" title={show(row[c])}>{show(row[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center gap-2 text-[10px] text-muted print:hidden" data-testid="object-pager">
          <button type="button" disabled={at === 0} onClick={() => setPage(at - 1)} className="rounded border border-line px-1.5 disabled:opacity-40" aria-label="Previous objects">‹</button>
          <span>{(from + 1).toLocaleString()}–{upto.toLocaleString()} of {rows.length.toLocaleString()}</span>
          <button type="button" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} className="rounded border border-line px-1.5 disabled:opacity-40" aria-label="Next objects">›</button>
        </div>
      )}
      {total > (compact ? Math.min(rows.length, size) : rows.length) && (
        // the same note as the Markdown / DOCX / PowerPoint exports (printed with the page in a PDF)
        <p className="text-[10px] text-muted" data-testid="object-cut-note">First {(compact ? Math.min(rows.length, size) : rows.length).toLocaleString()} of {total.toLocaleString()} objects (the CSV export has every object).</p>
      )}
    </div>
  );
}

/** A new object set card reading the analysis' last object set (or an object view to be pointed at one). */
export function newObjectCard(kind: ObjectSetSingleCard["kind"], id: string, input?: { id: string; kind: string }): ObjectSetSingleCard {
  const src = input && (OBJECT_INPUT_KINDS as readonly string[]).includes(input.kind) ? input.id : "";
  switch (kind) {
    case "filter_object_set": return { id, kind, title: "Filter object set", source: { card: src }, match: "all", conditions: [{ property: "", op: "eq", value: "" }] };
    case "set_math": return { id, kind, title: "Set math", inputs: [src, ""], op: "union" };
    case "linked_object_set": return { id, kind, title: "Linked object set", source: { card: src }, link: "" };
    case "status_filter": return { id, kind, title: "Status filter", source: { card: src }, start_property: "", end_property: "", status: "open" };
    case "object_view": return { id, kind, title: "Object view", source: { card: "" } };
    case "defined_by_property": return { id, kind, title: "Defined by property", source: { card: src }, property: "", from: { card: "", property: "" } };
    case "saved_object_set": return { id, kind, title: "Import saved object set", object_set: "" };
  }
}
