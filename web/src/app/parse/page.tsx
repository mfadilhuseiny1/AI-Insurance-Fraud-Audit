"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BatchSetup } from "@/components/BatchSetup";
import { Dropzone } from "@/components/Dropzone";
import { ParsedDocuments } from "@/components/ParsedDocuments";
import { ApiError, Loading } from "@/components/States";
import { Workspace } from "@/components/Workspace";
import { api, type FileMeta } from "@/lib/api";
import { useConfig } from "@/lib/useConfig";

export default function ParsePage() {
  const router = useRouter();
  const { config, error } = useConfig();
  const [file, setFile] = useState<FileMeta | null>(null);
  // several files chosen: set up a batch
  const [batch, setBatch] = useState<FileMeta[] | null>(null);

  if (error) return <ApiError message={error} />;
  if (!config) return <Loading />;

  if (batch) {
    return (
      <BatchSetup
        config={config}
        files={batch}
        onFiles={(files) => (files.length ? setBatch(files) : setBatch(null))}
        onCancel={() => setBatch(null)}
      />
    );
  }

  if (!file) {
    return (
      <div className="dot-grid flex min-h-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-line bg-panel px-5 text-sm">Parse</header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Dropzone onUploaded={setFile} onBatch={setBatch} compact />
          <ParsedDocuments />
        </div>
      </div>
    );
  }

  return (
    <Workspace
      config={config}
      file={file}
      onRun={async (s) => {
        const job = await api.createJob({
          file_id: file.id,
          tier: s.tier,
          page_from: s.pageFrom,
          page_to: s.pageTo,
          languages: s.languages,
          instructions: s.instructions || undefined,
        });
        router.push(`/parse/${job.id}`);
      }}
    />
  );
}
