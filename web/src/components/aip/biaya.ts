"use client";

import { useSyncExternalStore } from "react";

/**
 * Model costs stay off AIP JKN's screens unless the viewer turns them on from the cost button in the header (the user,
 * 2026-10-28: "user gausah tau, tapi tambah button buat liat cost nya"). Per browser; Evaluasi Swarm follows it too.
 */
const KEY = "aip.biaya.tampil";
const EVENT = "aip-biaya";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setTampilBiaya(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: this page only */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** whether cost figures are shown (hidden by default, and while rendering on the server) */
export function useTampilBiaya(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
