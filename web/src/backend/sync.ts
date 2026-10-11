// AnkiWeb sync.
//
// rslib is the sync client; none of the protocol lives here. Our job is to
// hold the credentials, call the right method, and make the destructive case
// impossible to trigger by accident.

import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "../gen/anki/generic_pb.js";
import {
  FullUploadOrDownloadRequestSchema,
  SyncAuthSchema,
  SyncCollectionRequestSchema,
  SyncCollectionResponseSchema,
  SyncCollectionResponse_ChangesRequired,
  SyncLoginRequestSchema,
  SyncStatusResponseSchema,
  SyncStatusResponse_Required,
} from "../gen/anki/sync_pb.js";
import { call } from "./client.js";
import { loadPrefs, savePrefs, type StoredSyncAuth } from "./prefs.js";

export interface LoginDetails {
  username: string;
  password: string;
  /** Defaults to AnkiWeb; set for a self-hosted sync server. */
  endpoint?: string;
}

/** Exchanges a password for a sync key. The password is never stored. */
export async function login(details: LoginDetails): Promise<StoredSyncAuth> {
  const auth = await call(
    "syncLogin",
    SyncLoginRequestSchema,
    create(SyncLoginRequestSchema, {
      username: details.username,
      password: details.password,
      endpoint: details.endpoint,
    }),
    SyncAuthSchema,
  );

  const stored: StoredSyncAuth = { hkey: auth.hkey, endpoint: auth.endpoint };
  const prefs = await loadPrefs();
  await savePrefs({ ...prefs, syncAuth: stored, syncUsername: details.username });
  return stored;
}

export async function logout(): Promise<void> {
  const prefs = await loadPrefs();
  delete prefs.syncAuth;
  delete prefs.syncUsername;
  await savePrefs(prefs);
}

function toAuth(stored: StoredSyncAuth) {
  return create(SyncAuthSchema, { hkey: stored.hkey, endpoint: stored.endpoint });
}

export type SyncNeed = "none" | "normal" | "full";

/** Cheap check for whether anything needs syncing. */
export async function status(stored: StoredSyncAuth): Promise<SyncNeed> {
  const response = await call(
    "syncStatus",
    SyncAuthSchema,
    toAuth(stored),
    SyncStatusResponseSchema,
  );
  switch (response.required) {
    case SyncStatusResponse_Required.NO_CHANGES:
      return "none";
    case SyncStatusResponse_Required.NORMAL_SYNC:
      return "normal";
    default:
      return "full";
  }
}

export type SyncOutcome =
  | { kind: "done"; message: string }
  /**
   * A full sync replaces one side wholesale. Which side is safe depends on
   * where the real data is, and only the user knows that, so this is returned
   * for confirmation rather than resolved automatically.
   */
  | { kind: "needsFullSync"; direction: "either" | "upload" | "download"; message: string };

/** Runs a normal sync, reporting back when a full sync is unavoidable. */
export async function syncCollection(stored: StoredSyncAuth): Promise<SyncOutcome> {
  const response = await call(
    "syncCollection",
    SyncCollectionRequestSchema,
    create(SyncCollectionRequestSchema, { auth: toAuth(stored), syncMedia: true }),
    SyncCollectionResponseSchema,
  );

  const message = response.serverMessage;
  switch (response.required) {
    case SyncCollectionResponse_ChangesRequired.NO_CHANGES:
      return { kind: "done", message: message || "Already up to date." };
    case SyncCollectionResponse_ChangesRequired.NORMAL_SYNC:
      return { kind: "done", message: message || "Sync complete." };
    case SyncCollectionResponse_ChangesRequired.FULL_UPLOAD:
      return {
        kind: "needsFullSync",
        direction: "upload",
        message: message || "AnkiWeb has no cards; this device's collection must be uploaded.",
      };
    case SyncCollectionResponse_ChangesRequired.FULL_DOWNLOAD:
      return {
        kind: "needsFullSync",
        direction: "download",
        message: message || "This device has no cards; AnkiWeb's collection must be downloaded.",
      };
    default:
      return {
        kind: "needsFullSync",
        direction: "either",
        message:
          message ||
          "The collections have diverged too far to merge. One side must replace the other.",
      };
  }
}

/**
 * Replaces one collection with the other. Destructive by definition — the
 * losing side's changes are gone — so callers must confirm first.
 */
export async function fullSync(
  stored: StoredSyncAuth,
  direction: "upload" | "download",
): Promise<void> {
  await call(
    "fullUploadOrDownload",
    FullUploadOrDownloadRequestSchema,
    create(FullUploadOrDownloadRequestSchema, {
      auth: toAuth(stored),
      upload: direction === "upload",
    }),
    EmptySchema,
  );
}

export async function abort(): Promise<void> {
  await call("abortSync", EmptySchema, create(EmptySchema, {}), EmptySchema);
}
