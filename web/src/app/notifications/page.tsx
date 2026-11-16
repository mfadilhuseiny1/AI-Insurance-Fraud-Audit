"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { ApiError } from "@/components/States";
import { when } from "@/lib/format";
import { notifications, type Notification } from "@/lib/actions";

/** The notifications inbox: messages sent to the signed-in user by action types' notification rules. */
export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    notifications.list().then((r) => setItems(r.notifications), (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const read = async (n: Notification) => {
    if (n.read) return;
    await notifications.read(n.id).catch(() => undefined);
    setItems((cur) => cur?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? null);
  };
  if (error && !items) return <ApiError message={error} />;
  const shown = (items ?? []).filter((n) => !unreadOnly || !n.read);
  return (
    <div className="dot-grid flex-1 overflow-y-auto">
      <AppHeader app="Notifications" icon="bell" href="/notifications">
        <label className="flex items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
        </label>
        <button
          type="button"
          onClick={async () => {
            await Promise.all((items ?? []).filter((n) => !n.read).map((n) => notifications.read(n.id).catch(() => undefined)));
            load();
          }}
          className="text-xs text-ocean hover:underline"
        >
          Mark all read
        </button>
      </AppHeader>
      <div className="mx-auto max-w-3xl space-y-2 p-8">
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-muted">Sent to you by actions with notification rules.</p>
        {items !== null && shown.length === 0 && <p className="pt-4 text-sm text-muted">No notifications.</p>}
        {shown.map((n) => (
          <div key={n.id} onClick={() => read(n)} className={`rounded-xl border bg-panel p-4 ${n.read ? "border-line" : "border-ocean/40"}`}>
            <div className="flex items-center gap-2 text-sm">
              {!n.read && <span className="h-2 w-2 rounded-full bg-ocean" />}
              <span className="font-medium">{n.subject}</span>
              <span className="ml-auto text-xs text-muted">
                {n.from} · {when(n.at)}
              </span>
            </div>
            {n.body && <p className="mt-1 whitespace-pre-wrap text-sm text-soft">{n.body}</p>}
            <div className="mt-2 flex gap-3 text-xs">
              {n.link && (
                <Link href={n.link} className="text-ocean hover:underline">
                  {n.link_label || "Open"}
                </Link>
              )}
              <Link href={`/ontology/action-types/${n.action_type_id}`} className="flex items-center gap-1 text-muted hover:text-white">
                <Icon name="bolt" className="h-3 w-3" /> Action type
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
