"use client";

import { useState } from "react";
import { API_URL, type AppConfig } from "@/lib/api";
import type { ParseSettings } from "./ConfigPanel";
import { Icon } from "./Icon";

export function CodePanel({
  config,
  settings,
  fileName,
}: {
  config: AppConfig;
  settings: ParseSettings;
  fileName: string;
}) {
  const [copied, setCopied] = useState(false);
  const tier = config.tiers.find((t) => t.id === settings.tier) ?? config.tiers[0];
  const body: Record<string, unknown> = {
    file_id: "<file_id>",
    tier: tier.id,
    page_from: settings.pageFrom,
    page_to: settings.pageTo,
    languages: settings.languages,
  };
  if (settings.instructions && tier.id.startsWith("agentic")) body.instructions = settings.instructions;

  const code = `# 1. upload
curl -F "file=@${fileName}" ${API_URL}/api/files
# -> {"id": "<file_id>", "pages": ...}

# 2. start a parse job (tier: ${config.tiers.map((t) => t.id).join(" | ")})
curl -X POST ${API_URL}/api/jobs \\
  -H "content-type: application/json" \\
  -d '${JSON.stringify(body)}'
# -> {"id": "<job_id>", "status": "queued", "estimated_price": ...}

# 3. poll until "status": "completed" (pages_done and price update live)
curl ${API_URL}/api/jobs/<job_id>

# 4. download the result: json | md | txt
curl -OJ ${API_URL}/api/jobs/<job_id>/download/json`;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-md bg-panel-2 px-3 py-1 text-sm text-white ring-1 ring-line-2">cURL (REST API)</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-soft hover:text-white"
        >
          <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-ink p-4 font-mono text-[12.5px] leading-relaxed text-soft">
        {code}
      </pre>
    </div>
  );
}
