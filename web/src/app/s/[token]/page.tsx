"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Preview } from "@/components/drive/dialogs";
import { buttonClass, iconColor, iconFor, previewable, typeLabel } from "@/components/drive/ui";
import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import { api, sharedContentUrl, sharedZipUrl, type SharedView } from "@/lib/api";
import { bytes, when } from "@/lib/format";

/** What someone opening a share link sees: the shared file, or the shared folder to browse and
 * download. Covers the app's sidebar, since a link visitor has no use for it. */
export default function SharedPage() {
  const { token } = useParams<{ token: string }>();
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [data, setData] = useState<SharedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);

  useEffect(() => {
    let stale = false;
    api.drive
      .shared(token, folder)
      .then((d) => !stale && (setData(d), setError(null)))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [token, folder]);

  const go = (id: string | undefined) => {
    setData(null);
    setFolder(id);
  };

  const isFile = data?.root.kind === "file";
  const files = isFile && data ? [data.root] : (data?.items.filter((i) => i.kind === "file") ?? []);
  const url = (id: string, inline = false) => sharedContentUrl(token, id, inline);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-panel px-6">
        <Logo />
        <span className="text-xs text-muted">Shared with you</span>
        {data && !isFile && (
          <a href={sharedZipUrl(token, folder)} className={`${buttonClass.primary} ml-auto flex items-center gap-1.5`}>
            <Icon name="download" className="h-4 w-4" /> Download {folder ? "this folder" : "all"} (zip)
          </a>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl">
          {error ? (
            <div className="mx-auto mt-20 max-w-md rounded-xl border border-line bg-panel p-8 text-center">
              <Icon name="link" className="mx-auto mb-3 h-10 w-10 text-muted" />
              <div className="font-medium">This link can&apos;t be opened</div>
              <p className="mt-1 text-sm text-muted">{error}</p>
            </div>
          ) : !data ? (
            <div className="mt-20 text-center text-sm text-muted">Loading…</div>
          ) : isFile ? (
            <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-line bg-panel p-8 text-center">
              <Icon name={iconFor(data.root)} className="mx-auto mb-3 h-14 w-14 text-ocean" />
              <div className="break-all text-lg font-semibold">{data.root.name}</div>
              <div className="mt-1 text-sm text-muted">
                {typeLabel(data.root)} · {bytes(data.root.size)} · updated {when(data.root.updated_at)}
              </div>
              <div className="mt-6 flex justify-center gap-2">
                {previewable(data.root) && (
                  <button type="button" onClick={() => setPreview(0)} className={`${buttonClass.ghost} flex items-center gap-1.5 border border-line-2`}>
                    <Icon name="eye" className="h-4 w-4" /> Preview
                  </button>
                )}
                <a href={url(data.root.id)} className={`${buttonClass.primary} flex items-center gap-1.5`}>
                  <Icon name="download" className="h-4 w-4" /> Download
                </a>
              </div>
              {data.expires_at && <p className="mt-6 text-xs text-muted">This link expires {when(data.expires_at)}.</p>}
            </div>
          ) : (
            <>
              <nav className="mb-4 flex flex-wrap items-center gap-1 text-sm">
                {data.path.map((p, i) => (
                  <span key={p.id} className="flex items-center gap-1">
                    {i > 0 && <Icon name="right" className="h-3.5 w-3.5 text-muted" />}
                    <button
                      type="button"
                      onClick={() => go(i === 0 ? undefined : p.id)}
                      className={`flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-panel-2 ${i === data.path.length - 1 ? "font-medium" : "text-soft"}`}
                    >
                      {i === 0 && <Icon name={iconFor(data.root)} className={`h-4 w-4 ${iconColor(data.root)}`} />}
                      {p.name}
                    </button>
                  </span>
                ))}
                {data.expires_at && <span className="ml-auto text-xs text-muted">Link expires {when(data.expires_at)}</span>}
              </nav>
              <div className="overflow-hidden rounded-xl border border-line">
                <table className="w-full table-fixed text-sm">
                  <thead className="bg-panel text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">Name</th>
                      <th className="w-44 px-3 py-2.5 font-medium">Last updated</th>
                      <th className="w-28 px-3 py-2.5 font-medium">Size</th>
                      <th className="w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => {
                      const container = item.kind !== "file";
                      const fileIndex = files.findIndex((f) => f.id === item.id);
                      return (
                        <tr
                          key={item.id}
                          onDoubleClick={() => (container ? go(item.id) : previewable(item) && setPreview(fileIndex))}
                          className="group border-t border-line hover:bg-panel/60"
                        >
                          <td className="px-4 py-2">
                            <button
                              type="button"
                              onClick={() => (container ? go(item.id) : previewable(item) ? setPreview(fileIndex) : window.location.assign(url(item.id)))}
                              className="flex max-w-full items-center gap-2.5 hover:text-ocean"
                            >
                              <Icon name={iconFor(item)} className={`h-4 w-4 shrink-0 ${iconColor(item)}`} />
                              <span className="truncate">{item.name}</span>
                            </button>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-soft">{when(item.updated_at)}</td>
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums text-soft">
                            {container ? `${item.items ?? 0} items` : bytes(item.size)}
                          </td>
                          <td className="px-3 text-right">
                            <a
                              href={container ? sharedZipUrl(token, item.id) : url(item.id)}
                              className="inline-flex rounded p-1.5 text-muted opacity-0 hover:bg-panel-2 hover:text-white group-hover:opacity-100"
                              title={container ? "Download as zip" : "Download"}
                            >
                              <Icon name="download" />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {data.items.length === 0 && <div className="border-t border-line py-16 text-center text-sm text-muted">This folder is empty.</div>}
              </div>
            </>
          )}
        </div>
      </main>

      {preview !== null && files[preview] && (
        <Preview
          items={files}
          index={preview}
          onIndex={setPreview}
          urlFor={(f) => url(f.id, true)}
          downloadUrlFor={(f) => url(f.id)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
