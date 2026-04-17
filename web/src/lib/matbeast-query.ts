"use client";

import { matbeastFetch } from "@/lib/matbeast-fetch";

/** JSON GET/POST/etc. via matbeastFetch; throws on non-OK (local server only). */
export async function matbeastJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await matbeastFetch(path, { ...init, cache: "no-store" });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const t = await res.text();
      if (t) msg = t;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
