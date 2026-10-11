// Typed wrappers for the handful of backend methods the shell needs so far.
// Method names match the routing table generated in rust/memoryanchor-core; a
// typo surfaces as a 404 from the server rather than a silent no-op.

import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "../gen/anki/generic_pb.js";
import {
  CloseCollectionRequestSchema,
  OpenCollectionRequestSchema,
} from "../gen/anki/collection_pb.js";
import { DeckNamesSchema, GetDeckNamesRequestSchema } from "../gen/anki/decks_pb.js";
import { call, config, dataDir } from "./client.js";

export interface CollectionPaths {
  collectionPath: string;
  mediaFolderPath: string;
  mediaDbPath: string;
}

/** Opens a collection, creating it if the file does not yet exist. */
export async function openCollection(paths: CollectionPaths): Promise<void> {
  await call(
    "openCollection",
    OpenCollectionRequestSchema,
    create(OpenCollectionRequestSchema, paths),
    EmptySchema,
  );
}

export async function closeCollection(downgradeToSchema11 = false): Promise<void> {
  await call(
    "closeCollection",
    CloseCollectionRequestSchema,
    create(CloseCollectionRequestSchema, { downgradeToSchema11 }),
    EmptySchema,
  );
}

export interface Deck {
  id: bigint;
  name: string;
}

export async function getDeckNames(options?: {
  skipEmptyDefault?: boolean;
  includeFiltered?: boolean;
}): Promise<Deck[]> {
  const response = await call(
    "getDeckNames",
    GetDeckNamesRequestSchema,
    create(GetDeckNamesRequestSchema, {
      skipEmptyDefault: options?.skipEmptyDefault ?? false,
      includeFiltered: options?.includeFiltered ?? true,
    }),
    DeckNamesSchema,
  );
  return response.entries.map((entry) => ({ id: entry.id, name: entry.name }));
}

/// Tells the backend where the collection's media and our own state live.
/// Media so card templates can resolve bare filenames; the data directory so
/// the sync key has somewhere to persist that survives a restart.
export async function setPaths(paths: CollectionPaths): Promise<void> {
  const { token, baseUrl } = config();
  const response = await fetch(`${baseUrl}/_anchor/paths`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mediaRoot: paths.mediaFolderPath, dataDir: dataDir() }),
  });
  if (!response.ok) {
    throw new Error(`could not configure paths: ${response.status}`);
  }
}

/// Paths for the single collection this app manages, under the directory the
/// native shell reserved for us.
export function defaultPaths(): CollectionPaths {
  const dir = dataDir();
  return {
    collectionPath: `${dir}/collection.anki2`,
    mediaFolderPath: `${dir}/collection.media`,
    mediaDbPath: `${dir}/collection.media.db2`,
  };
}

/// True when a collection is already open on the backend.
///
/// Probing beats catching the error: rslib reports an already-open collection
/// as a generic InvalidInput, which is indistinguishable from real bad input.
async function collectionIsOpen(): Promise<boolean> {
  try {
    await getDeckNames({ skipEmptyDefault: true, includeFiltered: false });
    return true;
  } catch {
    return false;
  }
}

/// Opens the app's collection and wires up paths.
///
/// Idempotent on purpose. The backend outlives the page: reloading the webview,
/// or the shell rebuilding it after iOS suspends the app, would otherwise fail
/// with CollectionAlreadyOpen.
export async function openDefaultCollection(): Promise<void> {
  const paths = defaultPaths();
  if (!(await collectionIsOpen())) {
    await openCollection(paths);
  }
  await setPaths(paths);
}
