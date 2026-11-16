"use client";

import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import type { ActionType } from "@/lib/ontology";
import type { InterfaceSource, Widget, WidgetConfig } from "@/lib/workshop";

/** An action button on an interface source: the object selected in a widget on the interface may be of any implementing
 * type, so the button runs the interface's action type constraint as that type maps it, the action chosen for that type,
 * an interface action (an interface reference parameter) or the chosen action when it belongs to the selected type. */
export function InterfaceActionConfig({ widget, set, interfaces, actions }: { widget: Widget; set: (c: Partial<WidgetConfig>) => void; interfaces: InterfaceSource[]; actions: ActionType[] }) {
  const c = widget.config;
  const iface = interfaces.find((x) => x.id === c.action_interface_id);
  // actions on this interface, on one it extends (every implementing object has it) or on one extending it (objects of
  // the types implementing that one: resolved per selected object)
  const ids = new Set([iface?.id, ...(iface?.extends ?? []), ...interfaces.filter((x) => iface && x.extends?.includes(iface.id)).map((x) => x.id)].filter(Boolean) as string[]);
  const inline = widget.type === "inline_action";
  const ifaceActions = actions.filter((a) => (a.parameters as unknown as { type: string; interface_id?: string }[]).some((p) => p.type === "interface" && p.interface_id && ids.has(p.interface_id)));
  return (
    <>
      <Field label="Selected object from" hint="An interface: the object selected in a table on that interface, of any implementing type">
        <select
          value={c.action_interface_id ?? ""}
          onChange={(e) => set({ action_interface_id: e.target.value || undefined, action_constraint: undefined, action_by_type: undefined })}
          className={inputClass}
        >
          <option value="">The action&apos;s object type</option>
          {interfaces.map((x) => (
            <option key={x.id} value={x.id}>
              Interface: {x.name}
            </option>
          ))}
        </select>
      </Field>
      {iface && (
        <div className="space-y-2 rounded-md border border-line p-2" data-interface-action-config={iface.id}>
          <Field label="Action type constraint" hint={iface.action_constraints?.length ? "Run the concrete action each implementing type maps it to" : "The interface has no action type constraints"}>
            <select value={c.action_constraint ?? ""} onChange={(e) => set({ action_constraint: e.target.value || undefined })} className={inputClass} disabled={!iface.action_constraints?.length}>
              <option value="">None</option>
              {(iface.action_constraints ?? []).map((a) => (
                <option key={a.api_name} value={a.api_name}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </Field>
          {ifaceActions.length > 0 && (
            <div className="text-[11px] text-muted">
              Interface actions ({inline ? "add them to the action types above: the ones that apply to the selected object's type are offered in a menu" : "choose one as the widget's action"}):{" "}
              {ifaceActions.map((a) => a.display_name).join(", ")}
            </div>
          )}
          <Field label="Action per object type" hint="Overrides the constraint and the action for objects of that type">
            <div className="space-y-1">
              {(iface.types ?? []).map((t) => (
                <div key={t.id} className="flex items-center gap-2 text-xs">
                  <span className="w-1/3 truncate text-muted" title={t.name}>
                    {t.name}
                  </span>
                  <select
                    value={c.action_by_type?.[t.id] ?? ""}
                    onChange={(e) => {
                      const next = { ...(c.action_by_type ?? {}) };
                      if (e.target.value) next[t.id] = e.target.value;
                      else delete next[t.id];
                      set({ action_by_type: Object.keys(next).length ? next : undefined });
                    }}
                    className={`${inputClass} flex-1`}
                  >
                    <option value="">—</option>
                    {actions
                      .filter((a) => a.object_type_id === t.id && a.kind !== "create")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.display_name}
                        </option>
                      ))}
                  </select>
                </div>
              ))}
            </div>
          </Field>
        </div>
      )}
    </>
  );
}
