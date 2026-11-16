"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, Loading } from "@/components/States";
import { Workspace } from "@/components/Workspace";
import { api, type FileMeta, type Job } from "@/lib/api";
import { useConfig } from "@/lib/useConfig";

export default function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const { config, error: configError } = useConfig();
  const [job, setJob] = useState<Job | null>(null);
  const [file, setFile] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bumped by Pause / Resume / Stop, so polling starts again for a resumed job
  const [kick, setKick] = useState(0);

  // poll the job until it finishes (or is paused or stopped)
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api.job(jobId);
        if (stop) return;
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer = setTimeout(tick, 2000);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId, kick]);

  const fileId = job?.file_id;
  useEffect(() => {
    if (fileId) api.file(fileId).then(setFile).catch((e: Error) => setError(e.message));
  }, [fileId]);

  if (configError || error) return <ApiError message={configError ?? error!} />;
  if (!config || !job || !file) return <Loading />;

  return (
    <Workspace
      key={job.id}
      config={config}
      file={file}
      job={job}
      onJobChanged={(j) => {
        setJob(j);
        setKick((k) => k + 1);
      }}
      onRun={async (s) => {
        const next = await api.createJob({
          file_id: file.id,
          tier: s.tier,
          page_from: s.pageFrom,
          page_to: s.pageTo,
          languages: s.languages,
          instructions: s.instructions || undefined,
        });
        router.push(`/parse/${next.id}`);
      }}
    />
  );
}
