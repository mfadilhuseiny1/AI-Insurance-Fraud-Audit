import { API_URL } from "@/lib/api";
import { Icon } from "./Icon";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted">
      <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-line-2 border-t-ocean" />
      {label}
    </div>
  );
}

export function ApiError({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-xl border border-bad/40 bg-bad/10 p-5 text-sm">
        <div className="mb-2 flex items-center gap-2 font-semibold text-bad">
          <Icon name="alert" /> Cannot reach the BluesandAI API
        </div>
        <p className="text-soft">
          {message}. Make sure the API server is running at <code className="text-white">{API_URL || (typeof window !== "undefined" ? window.location.origin : "this site")}</code>.
        </p>
      </div>
    </div>
  );
}
