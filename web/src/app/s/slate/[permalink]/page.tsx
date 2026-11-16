"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SlateViewer } from "@/components/slate/SlateView";
import { slate, type SlateDocument } from "@/lib/slate";

/** A public Slate application: its published version, for anyone with the link (no sign-in). */
export default function PublicSlatePage() {
  const { permalink } = useParams<{ permalink: string }>();
  const [app, setApp] = useState<{ id: string; name: string; doc: SlateDocument } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    slate.publicApp(permalink).then(
      (r) => {
        setApp({ id: r.app.id, name: r.app.name, doc: r.document });
        document.title = r.app.name;
      },
      (e: Error) => setError(e.message),
    );
  }, [permalink]);
  if (error) return <div className="flex min-h-screen items-center justify-center bg-ink p-8 text-sm text-muted">{error}</div>;
  if (!app) return <div className="flex min-h-screen items-center justify-center bg-ink text-sm text-muted">Loading…</div>;
  return (
    <div className="min-h-screen bg-ink text-soft">
      <SlateViewer doc={app.doc} appId={app.id} publicApp />
    </div>
  );
}
