"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox, Field, ObjectPicker, ParamInput } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { actions, type ActionParam, type ApplyResult, type FormState, type ParamState } from "@/lib/actions";
import { ontology, typeLabel, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { scenarios } from "@/lib/scenarios";
import { CheckpointFields, checkpointReady } from "@/components/security/CheckpointForm";
import { checkpointsApi, type CheckpointAnswer, type CheckpointPrompt } from "@/lib/checkpoints";

const idOf = (v: unknown): unknown => (v && typeof v === "object" && "primary_key" in (v as object) ? (v as { primary_key: unknown }).primary_key : v);

/**
 * The action form: parameters with their server-resolved state (defaults, overrides, visibility, requiredness and
 * dropdown options), sections, the submission criteria, then the result with Revert.
 */
export function ActionForm({
  action,
  objectType,
  object,
  onClose,
  onDone,
  scenarioId,
  inline = false,
  defaults,
  title,
  hideHeader = false,
}: {
  action: ActionType;
  objectType: ObjectType;
  object?: OntologyObject;
  onClose: () => void;
  onDone: () => void;
  /** apply to this Ontology scenario instead of main (the form's options and criteria see the scenario) */
  scenarioId?: string;
  /** in the page instead of a modal (Workshop's Inline Action widget), with local parameter defaults and a title */
  inline?: boolean;
  defaults?: Record<string, unknown>;
  title?: string;
  hideHeader?: boolean;
}) {
  const params = action.parameters as unknown as ActionParam[];
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const p of params) {
      const target = p.object_type_id || action.object_type_id;
      if (object && p.type === "object" && target === object.object_type_id) init[p.id] = object.primary_key;
      else if (object && p.type === "interface") init[p.id] = { object_type_id: object.object_type_id, primary_key: object.primary_key };
      else if (object && action.kind === "modify" && p.property) init[p.id] = object.properties[p.property] ?? null;
      if (defaults && defaults[p.id] !== undefined && defaults[p.id] !== null && defaults[p.id] !== "") init[p.id] = defaults[p.id];
    }
    return init;
  });
  const [touched, setTouched] = useState<string[]>(() => Object.keys(values));
  const [state, setState] = useState<{ key: string; form: FormState } | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [reverted, setReverted] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Submit action checkpoints shown in the form (answered with the submission); reauthentication stays in the dialog
  const [prompts, setPrompts] = useState<CheckpointPrompt[]>([]);
  const [answers, setAnswers] = useState<Record<string, CheckpointAnswer>>({});
  const key = JSON.stringify(values);
  const form = state?.form;
  useEffect(() => {
    const k = JSON.stringify(values);
    const t = setTimeout(
      () => (scenarioId ? scenarios.form(scenarioId, action.id, values, touched) : actions.form(action.id, values, touched)).then((f) => setState({ key: k, form: f }), (e: Error) => setError(e.message)),
      150,
    );
    return () => clearTimeout(t);
  }, [action.id, values, touched, scenarioId]);
  useEffect(() => {
    if (params.some((p) => p.type === "object_type")) ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, [params]);
  useEffect(() => {
    if (scenarioId) return;
    checkpointsApi.evaluate({ type: "submit_action", action_type: action.id, object_type: action.object_type_id || undefined }).then(
      (r) => setPrompts(r.checkpoints.some((c) => c.justification.kind === "reauthentication") ? [] : r.checkpoints),
      () => setPrompts([]),
    );
  }, [action.id, action.object_type_id, scenarioId]);
  const justified = prompts.every((c) => checkpointReady(c, answers[c.config_id]));
  const stale = state?.key !== key;
  const set = (id: string, v: unknown) => {
    setValues((cur) => ({ ...cur, [id]: v }));
    setTouched((cur) => (cur.includes(id) ? cur : [...cur, id]));
  };
  const byId = Object.fromEntries((form?.parameters ?? []).map((s) => [s.id, s]));
  const value = (p: ActionParam) => (touched.includes(p.id) ? values[p.id] : idOf(byId[p.id]?.value));

  const input = (p: ActionParam, st: ParamState) => {
    const v = value(p);
    if (st.options && p.type !== "object_type") {
      if (p.array)
        return (
          <select
            multiple
            disabled={st.disabled}
            value={((v as unknown[]) ?? []).map(String)}
            onChange={(e) => set(p.id, [...e.target.selectedOptions].map((o) => o.value))}
            className={`${inputClass} h-24`}
          >
            {st.options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
        );
      return (
        <select disabled={st.disabled} value={v === null || v === undefined ? "" : String(v)} onChange={(e) => set(p.id, e.target.value || null)} className={inputClass}>
          <option value="">—</option>
          {st.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (p.type === "object")
      return <ObjectPicker objectTypeId={p.object_type_id || action.object_type_id || objectType.id} value={String(v ?? "")} onChange={(pk) => set(p.id, pk || null)} />;
    if (p.type === "interface")
      return (
        <ObjectPicker
          objectTypeId={((v as { object_type_id?: string }) ?? {}).object_type_id || objectType.id}
          value={String(idOf(v) ?? "")}
          onChange={(pk) => set(p.id, pk ? { object_type_id: ((v as { object_type_id?: string }) ?? {}).object_type_id || objectType.id, primary_key: pk } : null)}
        />
      );
    if (p.type === "object_type")
      return (
        <select disabled={st.disabled} value={String(v ?? "")} onChange={(e) => set(p.id, e.target.value || null)} className={inputClass}>
          <option value="">Pick an object type…</option>
          {types
            .filter((t) => !p.interface_id || (t.implements ?? []).some((i) => i.interface_id === p.interface_id))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
              </option>
            ))}
        </select>
      );
    if (p.type === "user" || p.type === "group")
      return <input disabled={st.disabled} value={String(v ?? "")} onChange={(e) => set(p.id, e.target.value)} placeholder={p.type === "user" ? "User ID" : "Group ID"} className={inputClass} />;
    const prop = objectType.properties.find((x) => x.api_name === p.property);
    return (
      <fieldset disabled={st.disabled}>
        <ParamInput param={{ type: p.type as never, array: p.array }} objectTypeId={objectType.id} value={v} property={prop} onChange={(x) => set(p.id, x)} />
      </fieldset>
    );
  };

  const field = (p: ActionParam) => {
    const st = byId[p.id];
    if (!st || !st.visible) return null;
    return (
      <Field
        key={p.id}
        label={`${p.display_name}${st.required ? " *" : ""}`}
        hint={form?.errors[p.id] ?? (p.description || (p.type === "object" ? undefined : typeLabel(p.type, p.array)))}
      >
        {input(p, st)}
      </Field>
    );
  };

  const inSection = new Set((form?.sections ?? []).flatMap((s) => s.parameters));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const sent: Record<string, unknown> = {};
      for (const id of touched) sent[id] = values[id];
      setResult(scenarioId ? await scenarios.apply(scenarioId, action.id, sent) : await actions.apply(action.id, sent, prompts.length ? answers : undefined));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const heading = title || action.display_name;
  const shell = (icon: "check" | "trash" | "edit", close: () => void, wide: boolean, children: React.ReactNode) =>
    inline ? (
      <div className="h-full overflow-y-auto" data-inline-action={action.id}>
        {!hideHeader && <div className="border-b border-line px-4 py-2 text-sm font-semibold">{heading}</div>}
        {children}
      </div>
    ) : (
      <Modal title={heading} icon={icon} onClose={close} wide={wide}>
        {children}
      </Modal>
    );
  if (result)
    return shell(
      "check",
      onDone,
      false,
      <>
        <div className="space-y-3 p-4 text-sm">
          <div className={`rounded-md px-3 py-2 ${reverted ? "bg-panel-2 text-soft" : "bg-ok/10 text-ok"}`}>
            {reverted ? "Edits reverted." : `Edits applied${scenarioId ? " to the scenario" : ""}: ${result.edits.length} object${result.edits.length === 1 ? "" : "s"}${result.links.length ? `, ${result.links.length} links` : ""}.`}
          </div>
          {!reverted && (
            <ul className="space-y-1 text-xs text-soft">
              {result.edits.slice(0, 8).map((e) => (
                <li key={`${e.object_type_id}:${e.primary_key}`}>
                  <span className="capitalize">{e.op}</span> {e.title ?? e.primary_key}
                </li>
              ))}
              {result.notifications?.length ? <li>Notified {result.notifications.length} user(s)</li> : null}
              {result.notification_error ? <li className="text-warn">Notifications not sent: {result.notification_error}</li> : null}
              {result.webhooks?.map((w) => (
                <li key={w.webhook_id}>Webhook: {w.status}</li>
              ))}
              {result.schedule_run && <li>Schedule run {result.schedule_run}</li>}
            </ul>
          )}
          <ErrorBox message={error} />
          <div className="flex justify-end gap-2">
            {result.revertible && !reverted && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await actions.revert(result.action_rid);
                    setReverted(true);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                className={buttonClass.secondary}
              >
                <Icon name="restore" className="h-3.5 w-3.5" /> Revert
              </button>
            )}
            <button type="button" onClick={onDone} className={buttonClass.primary}>
              {inline ? "Submit another" : "Done"}
            </button>
          </div>
        </div>
      </>,
    );

  return shell(
    action.kind === "delete" ? "trash" : "edit",
    onClose,
    true,
    <>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {action.description && <p className="text-sm text-muted">{action.description}</p>}
        {!form ? (
          <p className="text-sm text-muted">Loading the form…</p>
        ) : (
          <>
            {form.sections
              .filter((s) => !s.hidden)
              .map((s) => (
                <section key={s.id} className="rounded-lg border border-line-2">
                  <button
                    type="button"
                    disabled={!s.collapsible}
                    onClick={() => setCollapsed({ ...collapsed, [s.id]: !(collapsed[s.id] ?? s.collapsed) })}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
                  >
                    {s.collapsible && <Icon name={(collapsed[s.id] ?? s.collapsed) ? "right" : "down"} className="h-3.5 w-3.5 text-muted" />}
                    {s.title}
                  </button>
                  {!(collapsed[s.id] ?? s.collapsed) && (
                    <div className="space-y-3 px-3 pb-3">
                      {s.description && <p className="text-xs text-muted">{s.description}</p>}
                      <div className={`grid gap-3 ${s.columns === 2 ? "sm:grid-cols-2" : ""}`}>
                        {s.parameters.map((id) => params.find((p) => p.id === id)).map((p) => p && field(p))}
                      </div>
                    </div>
                  )}
                </section>
              ))}
            {params.filter((p) => !inSection.has(p.id)).map(field)}
            {!form.criteria.passed && (
              <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
                {form.criteria.failures.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </div>
            )}
          </>
        )}
        {prompts.length > 0 && (
          <div className="space-y-2">
            <CheckpointFields checkpoints={prompts} answers={answers} set={(id, a) => setAnswers((x) => ({ ...x, [id]: { ...x[id], ...a } }))} />
            <p className="text-[11px] text-muted">Your justification is recorded with this action and can be reviewed by data governance officers.</p>
          </div>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          {!inline && (
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
          )}
          <button type="submit" disabled={busy || !form || stale || !form.criteria.passed || !justified} className={buttonClass.primary}>
            <Icon name={action.kind === "delete" ? "trash" : "check"} className="h-3.5 w-3.5" /> {busy ? "Applying…" : "Submit"}
          </button>
        </div>
      </form>
    </>,
  );
}
