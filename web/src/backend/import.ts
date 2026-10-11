// Importing .apkg / .colpkg packages.
//
// rslib's importAnkiPackage takes a path on disk rather than bytes, so the
// file the user picked is uploaded to the backend first and imported from
// where it landed. Inside a WKWebView an <input type="file"> opens the system
// document picker, so this same flow works on device and in a dev browser.

import { create } from "@bufbuild/protobuf";
import {
  ImportAnkiPackageOptionsSchema,
  ImportAnkiPackageRequestSchema,
  ImportResponseSchema,
} from "../gen/anki/import_export_pb.js";
import { BackendError, call, config } from "./client.js";

/** Stores a picked file on the backend and returns the path it was written to. */
async function upload(file: File, signal?: AbortSignal): Promise<string> {
  const { token, baseUrl } = config();
  const response = await fetch(`${baseUrl}/_anchor/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "x-anchor-filename": encodeURIComponent(file.name),
    },
    body: file,
    signal,
  });
  if (!response.ok) {
    throw new BackendError(response.status, await response.text().catch(() => ""));
  }
  const { path } = (await response.json()) as { path: string };
  return path;
}

export interface ImportSummary {
  added: number;
  updated: number;
  duplicates: number;
  skipped: number;
}

/**
 * Imports a package. Scheduling and deck presets come across by default,
 * matching what Anki does when you open a shared deck.
 */
export async function importPackage(
  file: File,
  signal?: AbortSignal,
): Promise<ImportSummary> {
  const packagePath = await upload(file, signal);

  const response = await call(
    "importAnkiPackage",
    ImportAnkiPackageRequestSchema,
    create(ImportAnkiPackageRequestSchema, {
      packagePath,
      options: create(ImportAnkiPackageOptionsSchema, {
        mergeNotetypes: false,
        withScheduling: true,
        withDeckConfigs: true,
      }),
    }),
    ImportResponseSchema,
    signal,
  );

  const log = response.log;
  return {
    added: log?.new.length ?? 0,
    updated: log?.updated.length ?? 0,
    duplicates: log?.duplicate.length ?? 0,
    skipped:
      (log?.conflicting.length ?? 0) +
      (log?.missingNotetype.length ?? 0) +
      (log?.missingDeck.length ?? 0),
  };
}
