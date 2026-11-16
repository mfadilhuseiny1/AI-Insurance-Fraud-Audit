"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { reports } from "@/lib/reports";

type Row = Awaited<ReturnType<typeof reports.list>>[number];

/** Reports [Sunset]: parameterized reports of widgets on live data; Notepad is the successor. */
export default function ReportsHome() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled report");
  useEffect(() => {
    reports.list().then(setRows, (e: Error) => setError(e.message));
  }, []);
  return (
    <AppHome
      app="Reports (Sunset)"
      icon="doc"
      accent="#8b5cf6"
      href="/reports"
      tagline="Parameterized reports of text, tables, charts and metrics on live data — in sunset, Notepad is the successor."
      description={
        <>
          Reports of text, tables, charts and metrics on live datasets and Nexus objects, with parameters; export to PDF, PowerPoint, CSV or Markdown. Reports is in sunset: convert reports to{" "}
          <Link href="/notepad" className="text-ocean hover:underline">
            Notepad
          </Link>
          .
        </>
      }
      noun={["report", "reports"]}
      items={rows?.map((r) => ({ id: r.id, href: `/reports/${r.id}`, title: r.name.replace(/\.report$/, ""), path: (r.path ?? []).map((p) => p.name), updated_at: r.updated_at })) ?? null}
      error={error}
      empty={{ title: "Write your first report", hint: "Reports is in sunset — for new work prefer Notepad. A report still runs widgets on live data.", steps: ["Name the report", "Add text, tables, charts and metrics", "Add parameters and export"] }}
      create={
        <>
          <div className="w-64">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} aria-label="Title" />
          </div>
          <button
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              try {
                const r = await reports.create(title.trim());
                router.push(`/reports/${r.item.id}?edit=1`);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> New report
          </button>
        </>
      }
    />
  );
}
