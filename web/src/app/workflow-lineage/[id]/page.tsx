"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { WorkflowLineageEditor } from "@/components/workflowLineage/Editor";

function Inner() {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  return <WorkflowLineageEditor key={id} graphId={id === "new" ? null : id} add={q.get("add")} />;
}

export default function Page() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading…</p>}>
      <Inner />
    </Suspense>
  );
}
