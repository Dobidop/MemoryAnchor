// Small persistent store for state that is not Anki's business.
//
// This cannot be localStorage: the backend binds an ephemeral port, so the
// page's origin changes on every launch and browser storage goes with it.
// The backend keeps a JSON file beside the collection instead.

import { config } from "./client.js";

export interface StoredSyncAuth {
  hkey: string;
  endpoint?: string;
}

export interface Prefs {
  syncAuth?: StoredSyncAuth;
  syncUsername?: string;
}

async function request(method: "GET" | "PUT", body?: string): Promise<Response> {
  const { token, baseUrl } = config();
  return fetch(`${baseUrl}/_anchor/prefs`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
}

export async function loadPrefs(): Promise<Prefs> {
  const response = await request("GET");
  if (!response.ok) {
    throw new Error(`could not read prefs: ${response.status}`);
  }
  return (await response.json()) as Prefs;
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  const response = await request("PUT", JSON.stringify(prefs));
  if (!response.ok) {
    throw new Error(`could not save prefs: ${response.status}`);
  }
}
