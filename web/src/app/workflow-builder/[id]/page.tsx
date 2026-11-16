"use client";

import { useParams } from "next/navigation";
import { WorkflowBuilderEditor } from "@/components/workflowBuilder/Editor";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <WorkflowBuilderEditor key={id} id={id} />;
}
