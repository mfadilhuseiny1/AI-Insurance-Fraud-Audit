"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { auth, type Group, type User } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";
import { driveContentUrl } from "@/lib/api";
import { governance, type Portfolio, type Space } from "@/lib/governanceModel";
import { PrincipalList } from "../auth/GovernanceAdmin";
import { DrivePicker } from "../DrivePicker";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "../pipeline/Modal";
import { Field } from "../pipeline/ui";

/**
 * Compass → Portfolios: a space's Projects grouped for discovery. Everyone with access to the space sees its portfolios
 * (a Project inside still needs a role to open); the space's editors and a portfolio's curators manage its Projects,
 * documentation and promoted resources.
 */
export function Portfolios({ initial }: { initial?: string | null }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceId, setSpaceId] = useState("space-default");
  const [list, setList] = useState<Portfolio[] | null>(null);
  const [open, setOpen] = useState<string | null>(initial ?? null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => governance.portfolios(spaceId).then(setList, (e: Error) => setError(e.message)), [spaceId]);
  useEffect(() => {
    governance.spaces().then(setSpaces, () => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const space = spaces.find((s) => s.id === spaceId);
  if (open) return <PortfolioDetail id={open} onBack={() => (setOpen(null), load())} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)} className={`${inputClass} w-56`}>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {space?.my_workflows?.includes("manage_portfolios") && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              governance.createPortfolio({ space_id: spaceId, name: name.trim() }).then((p) => (setName(""), setOpen(p.id)), (er: Error) => setError(er.message));
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New portfolio name" className={`${inputClass} w-56`} />
            <button type="submit" disabled={!name.trim()} className={buttonClass.primary}>
              <Icon name="plus" /> Create
            </button>
          </form>
        )}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(list ?? []).map((p) => (
          <button key={p.id} type="button" onClick={() => setOpen(p.id)} className="rounded-xl border border-line bg-panel p-4 text-left hover:border-line-2">
            <div className="flex items-center gap-2">
              {p.thumbnail_item_id ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={driveContentUrl(p.thumbnail_item_id, true)} alt="" className="h-6 w-6 rounded-md object-cover" />
              ) : (
                <span className="h-6 w-6 rounded-md" style={{ background: p.color }} />
              )}
              <span className="font-medium">{p.name}</span>
            </div>
            {p.description && <p className="mt-1 text-xs text-muted">{p.description}</p>}
            <p className="mt-2 text-xs text-muted">
              {p.projects.length} project{p.projects.length === 1 ? "" : "s"}
              {p.hidden_projects ? ` (+${p.hidden_projects} you have no role on)` : ""}
            </p>
          </button>
        ))}
        {list && list.length === 0 && <p className="text-sm text-muted">No portfolios in this space yet.</p>}
      </div>
    </div>
  );
}

function PortfolioDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [p, setP] = useState<Portfolio | null>(null);
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ name: "", description: "", color: "#2f6fdf", curators: [] as string[], documentation: "" });
  const [spaceProjects, setSpaceProjects] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [picking, setPicking] = useState<"promote" | "thumbnail" | false>(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => governance.portfolio(id).then(setP, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);
  if (!p) return error ? <p className="text-sm text-bad">{error}</p> : <p className="text-sm text-muted">Loading…</p>;
  const save = (patch: Partial<typeof f> & { promoted?: string[]; thumbnail_item_id?: string | null } = {}) =>
    governance
      .updatePortfolio(p.id, {
        space_id: p.space_id,
        ...f,
        ...(edit ? {} : { name: p.name, description: p.description, color: p.color, curators: p.curators, documentation: p.documentation }),
        ...patch,
        promoted: patch.promoted ?? p.promoted.map((x) => x.id),
        thumbnail_item_id: "thumbnail_item_id" in patch ? patch.thumbnail_item_id : (p.thumbnail_item_id ?? null),
      })
      .then((r) => (setP(r), setEdit(false), setError(null)), (e: Error) => setError(e.message));
  const startEdit = () => {
    setF({ name: p.name, description: p.description, color: p.color, curators: p.curators, documentation: p.documentation });
    auth.users().then(setUsers, () => {});
    auth.groups().then(setGroups, () => {});
    setEdit(true);
  };
  const ids = p.projects.map((x) => x.id);
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-ocean hover:underline">
        ← Portfolios
      </button>
      <div className="flex items-center gap-3">
        {p.thumbnail_item_id ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={driveContentUrl(p.thumbnail_item_id, true)} alt="" className="h-9 w-9 rounded-lg object-cover" />
        ) : (
          <span className="h-9 w-9 rounded-lg" style={{ background: p.color }} />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{p.name}</h2>
          {p.description && <p className="text-sm text-muted">{p.description}</p>}
        </div>
        {p.can_curate && !edit && (
          <>
            <button type="button" onClick={startEdit} className={buttonClass.secondary}>
              Edit
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await confirmDialog(`Delete the portfolio ${p.name}? Its Projects stay.`)) governance.deletePortfolio(p.id).then(onBack, (e: Error) => setError(e.message));
              }}
              className={buttonClass.secondary}
            >
              <Icon name="trash" />
            </button>
          </>
        )}
      </div>
      {edit && (
        <div className="grid gap-3 rounded-xl border border-line bg-panel p-4 md:grid-cols-2">
          <Field label="Name">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Logo color, or a thumbnail image">
            <div className="flex items-center gap-2">
              <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-9 w-16 rounded border border-line bg-transparent" />
              <button type="button" onClick={() => setPicking("thumbnail")} className={buttonClass.secondary}>
                {p.thumbnail_item_id ? "Change image" : "Choose an image"}
              </button>
              {p.thumbnail_item_id && (
                <button type="button" onClick={() => save({ thumbnail_item_id: null })} className={buttonClass.ghost}>
                  Remove image
                </button>
              )}
            </div>
          </Field>
          <Field label="Description">
            <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Curators (add or remove its Projects)">
            <PrincipalList value={f.curators} onChange={(curators) => setF({ ...f, curators })} users={users} groups={groups} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Documentation (Markdown)">
              <textarea value={f.documentation} onChange={(e) => setF({ ...f, documentation: e.target.value })} rows={6} className={inputClass} />
            </Field>
          </div>
          <div className="flex justify-end gap-2 md:col-span-2">
            <button type="button" onClick={() => setEdit(false)} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" onClick={() => save()} className={buttonClass.primary}>
              Save
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium">Projects</h3>
            {p.can_curate && (
              <select
                value=""
                onFocus={() => spaceProjects.length || governance.spaceProjects(p.space_id).then(setSpaceProjects, () => {})}
                onChange={(e) => e.target.value && governance.setPortfolioProjects(p.id, [...ids, e.target.value]).then(setP, (er: Error) => setError(er.message))}
                className="rounded border border-line-2 bg-ink px-1 py-0.5 text-xs"
              >
                <option value="">+ Add a Project…</option>
                {spaceProjects
                  .filter((x) => !ids.includes(x.id))
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            )}
          </div>
          <ul className="space-y-1 text-sm">
            {p.projects.map((x) => (
              <li key={x.id} className="flex items-center gap-2">
                <Link href={`/files/${x.id}`} className="text-ocean hover:underline">
                  {x.name}
                </Link>
                {p.can_curate && (
                  <input
                    value={names[x.id] ?? p.display_names?.[x.id] ?? ""}
                    onChange={(e) => setNames({ ...names, [x.id]: e.target.value })}
                    onBlur={() =>
                      names[x.id] !== undefined &&
                      governance.setPortfolioProjects(p.id, ids, { ...(p.display_names ?? {}), [x.id]: names[x.id] }).then(setP, (e: Error) => setError(e.message))
                    }
                    placeholder="display name here"
                    className="w-36 rounded border border-line-2 bg-ink px-1 text-xs"
                    title="The Project's name in this portfolio"
                  />
                )}
                <span className="text-xs text-muted">{x.role ?? "no role"}</span>
                {p.can_curate && (
                  <button type="button" onClick={() => governance.setPortfolioProjects(p.id, ids.filter((y) => y !== x.id)).then(setP)} className="ml-auto text-xs text-muted hover:text-bad">
                    Remove
                  </button>
                )}
              </li>
            ))}
            {p.hidden_projects > 0 && <li className="text-xs text-muted">{p.hidden_projects} more you have no role on</li>}
          </ul>
        </section>
        <section className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium">Catalog (promoted resources)</h3>
            {p.can_curate && (
              <button type="button" onClick={() => setPicking("promote")} className="text-xs text-ocean hover:underline">
                + Add content
              </button>
            )}
          </div>
          <ul className="space-y-1 text-sm">
            {[...p.promoted].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).map((x, i, all) => (
              <Fragment key={x.id}>
                {(i === 0 || all[i - 1].kind !== x.kind) && <li key={`h-${x.kind}`} className="pt-1 text-[11px] uppercase tracking-wide text-muted">{x.kind}</li>}
              <li key={x.id} className="flex items-center gap-2">
                <Link href={`/files/${x.id}`} className="text-ocean hover:underline">
                  {x.name}
                </Link>
                <span className="text-xs text-muted">{x.kind}</span>
                {p.can_curate && (
                  <button type="button" onClick={() => save({ promoted: p.promoted.map((y) => y.id).filter((y) => y !== x.id) })} className="ml-auto text-xs text-muted hover:text-bad">
                    Remove
                  </button>
                )}
              </li>
              </Fragment>
            ))}
            {p.promoted.length === 0 && <li className="text-xs text-muted">Nothing promoted yet.</li>}
          </ul>
        </section>
      </div>
      {p.documentation && (
        <section className="rounded-xl border border-line bg-panel p-4">
          <h3 className="mb-2 font-medium">Documentation</h3>
          <pre className="whitespace-pre-wrap font-sans text-sm text-soft">{p.documentation}</pre>
        </section>
      )}
      {picking === "promote" && (
        <DrivePicker
          title="Promote a resource"
          onClose={() => setPicking(false)}
          onPick={(item) => {
            setPicking(false);
            save({ promoted: [...p.promoted.map((y) => y.id), item.id] });
          }}
        />
      )}
      {picking === "thumbnail" && (
        <DrivePicker
          title="Thumbnail image"
          canPick={(item) => (String(item.content_type ?? "").startsWith("image/") ? null : "choose an image")}
          onClose={() => setPicking(false)}
          onPick={(item) => {
            setPicking(false);
            save({ thumbnail_item_id: item.id });
          }}
        />
      )}
    </div>
  );
}
