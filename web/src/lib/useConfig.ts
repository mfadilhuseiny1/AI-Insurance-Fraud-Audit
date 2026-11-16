"use client";

import { useEffect, useState } from "react";
import { api, type AppConfig } from "./api";

export function useConfig(): { config: AppConfig | null; error: string | null } {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((e: Error) => setError(e.message));
  }, []);
  return { config, error };
}
