"use client";

import { Icon } from "@/components/Icon";

/** Where a single sign-on opened from a checkpoint's reauthentication prompt lands: back to the other tab. */
export default function CheckpointReauthenticated() {
  return (
    <main className="flex flex-1 items-center justify-center bg-ink p-6">
      <div className="max-w-md rounded-xl border border-line bg-panel p-6 text-center">
        <Icon name="check" className="mx-auto h-8 w-8 text-ok" />
        <h1 className="mt-3 text-lg font-semibold">You signed in again</h1>
        <p className="mt-2 text-sm text-muted">Close this tab and submit the checkpoint in the other one within 5 minutes (leave the password empty).</p>
        <button type="button" onClick={() => window.close()} className="mt-4 rounded-md border border-line-2 px-3 py-1.5 text-sm hover:text-white">
          Close this tab
        </button>
      </div>
    </main>
  );
}
