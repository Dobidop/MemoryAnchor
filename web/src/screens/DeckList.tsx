// Deck list with Anki's own due counts, plus .apkg import.
//
// Import uses a plain file input: inside a WKWebView that opens the system
// document picker, and in a desktop browser it opens the file dialog, so the
// same code path works on device and during development.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { importPackage, type ImportSummary } from "../backend/import.js";
import {
  dueTotal,
  initiallyCollapsed,
  visibleDecks,
  type DeckRow,
} from "../backend/decks.js";

interface Props {
  decks: DeckRow[];
  busy: boolean;
  syncedAs: string | null;
  onStudy: (deck: DeckRow) => void;
  onReload: () => Promise<void>;
  onOpenSync: () => void;
}

export function DeckList({ decks, busy, syncedAs, onStudy, onReload, onOpenSync }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  // Seeded from Anki's own collapsed flags so the list matches desktop.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initiallyCollapsed(decks));
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Let the same file be picked twice in a row.
      event.target.value = "";
      if (!file) return;

      setImporting(true);
      setError(null);
      setSummary(null);
      try {
        setSummary(await importPackage(file));
        await onReload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setImporting(false);
      }
    },
    [onReload],
  );

  // Re-seed when a different collection arrives, e.g. after a sync.
  useEffect(() => {
    setCollapsed(initiallyCollapsed(decks));
  }, [decks]);

  const toggle = useCallback((id: bigint) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      const key = String(id);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const rows = useMemo(() => visibleDecks(decks, collapsed), [decks, collapsed]);
  const studiable = decks.filter((deck) => dueTotal(deck) > 0).length;

  return (
    <div className="wrap">
      <header className="head">
        <h1>MemoryAnchor</h1>
        <p className="sub">
          {decks.length === 0
            ? "No decks yet — import an Anki package to begin."
            : `${decks.length} deck${decks.length === 1 ? "" : "s"}, ${studiable} with cards due`}
        </p>
      </header>

      {error && <p className="error">{error}</p>}

      {summary && (
        <p className="notice">
          Imported {summary.added} new note{summary.added === 1 ? "" : "s"}
          {summary.updated > 0 && `, updated ${summary.updated}`}
          {summary.duplicates > 0 && `, skipped ${summary.duplicates} duplicate`}
          {summary.skipped > 0 && `, ${summary.skipped} could not be imported`}.
        </p>
      )}

      {decks.length > 0 && (
        <ul className="decks">
          {rows.map((deck) => {
            const due = dueTotal(deck);
            const isCollapsed = collapsed.has(String(deck.id));
            return (
              <li key={String(deck.id)} className="deck-row">
                {deck.hasChildren ? (
                  <button
                    className="twisty"
                    onClick={() => toggle(deck.id)}
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${deck.label}`}
                    style={{ marginLeft: `${deck.level * 0.9}rem` }}
                  >
                    <span className={isCollapsed ? "chev collapsed" : "chev"}>›</span>
                  </button>
                ) : (
                  <span className="twisty-spacer" style={{ marginLeft: `${deck.level * 0.9}rem` }} />
                )}
                <button
                  className="deck"
                  onClick={() => onStudy(deck)}
                  disabled={busy || due === 0}
                >
                  <span className="deck-label">{deck.label}</span>
                  <span className="deck-counts">
                    {deck.newCount > 0 && <em className="new">{deck.newCount}</em>}
                    {deck.learnCount > 0 && <em className="learning">{deck.learnCount}</em>}
                    {deck.reviewCount > 0 && <em className="review">{deck.reviewCount}</em>}
                    {due === 0 && <em className="done">done</em>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="actions">
        <input
          ref={fileInput}
          type="file"
          accept=".apkg,.colpkg"
          hidden
          onChange={onPicked}
        />
        <button onClick={() => fileInput.current?.click()} disabled={importing}>
          {importing ? "Importing…" : "Import deck"}
        </button>
        <button className="secondary" onClick={onOpenSync} disabled={importing}>
          {syncedAs ? "Sync" : "Connect AnkiWeb"}
        </button>
      </div>
    </div>
  );
}
