"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loading } from "@/components/States";

/** The Evaluation Center is part of Experiments & Evaluations (its Benchmarks view): one app, not two. */
export default function EvaluationCenterRedirect() {
  const router = useRouter();
  useEffect(() => router.replace("/model-experiments?view=benchmarks"), [router]);
  return <Loading />;
}
