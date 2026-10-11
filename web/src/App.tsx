// Screen coordination: open the collection once, then move between the deck
// list and the reviewer.

import { useCallback, useEffect, useState } from "react";
import { health, NotConfiguredError, setMediaToken } from "./backend/client.js";
import { openDefaultCollection } from "./backend/collection.js";
import { deckTree, leafName, setCurrentDeck, type DeckRow } from "./backend/decks.js";
import { loadPrefs, type StoredSyncAuth } from "./backend/prefs.js";
import { DeckList } from "./screens/DeckList.js";
import { Sync } from "./screens/Sync.js";
import { Reviewer } from "./screens/Reviewer.js";

type Screen = { name: "decks" } | { name: "review"; deck: DeckRow } | { name: "sync" };

export function App() {
  const [ready, setReady] = useState(false);
  const [decks, setDecks] = useState<DeckRow[]>([]);
  const [screen, setScreen] = useState<Screen>({ name: "decks" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncAuth, setSyncAuth] = useState<StoredSyncAuth | null>(null);
  const [syncUser, setSyncUser] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setDecks(await deckTree());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setMediaToken((await health()).mediaToken);
        await openDefaultCollection();
        if (cancelled) return;
        const prefs = await loadPrefs();
        if (!cancelled) {
          setSyncAuth(prefs.syncAuth ?? null);
          setSyncUser(prefs.syncUsername ?? null);
        }
        await reload();
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) setError(describe(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const study = useCallback(async (deck: DeckRow) => {
    setBusy(true);
    setError(null);
    try {
      // The reviewer draws from the current deck, so select it first.
      await setCurrentDeck(deck.id);
      setScreen({ name: "review", deck });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const leaveReview = useCallback(async () => {
    setScreen({ name: "decks" });
    try {
      await reload();
    } catch (err) {
      setError(describe(err));
    }
  }, [reload]);

  if (error && !ready) {
    return (
      <div className="wrap">
        <h1>MemoryAnchor</h1>
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="wrap">
        <h1>MemoryAnchor</h1>
        <p className="sub">Opening collection…</p>
      </div>
    );
  }

  if (screen.name === "sync") {
    return (
      <Sync
        auth={syncAuth}
        username={syncUser}
        onAuthChanged={(auth, user) => {
          setSyncAuth(auth);
          setSyncUser(user);
        }}
        onSynced={reload}
        onClose={() => setScreen({ name: "decks" })}
      />
    );
  }

  if (screen.name === "review") {
    return <Reviewer deckName={leafName(screen.deck.name)} onFinished={leaveReview} />;
  }

  return (
    <>
      {error && (
        <div className="wrap">
          <p className="error">{error}</p>
        </div>
      )}
      <DeckList
        decks={decks}
        busy={busy}
        syncedAs={syncUser}
        onStudy={study}
        onReload={reload}
        onOpenSync={() => setScreen({ name: "sync" })}
      />
    </>
  );
}

function describe(err: unknown): string {
  if (err instanceof NotConfiguredError) {
    return "Open this through the MemoryAnchor app — the backend token is injected by the native shell.";
  }
  return err instanceof Error ? err.message : String(err);
}
