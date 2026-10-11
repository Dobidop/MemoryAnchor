// AnkiWeb sync.
//
// The destructive case gets the most attention here. A full sync replaces one
// collection wholesale, and only the user knows which side holds the work, so
// it is never chosen automatically and the confirmation names what is lost.

import { useCallback, useState } from "react";
import {
  fullSync,
  login,
  logout,
  syncCollection,
  syncMedia,
  type SyncOutcome,
} from "../backend/sync.js";
import type { StoredSyncAuth } from "../backend/prefs.js";

interface Props {
  auth: StoredSyncAuth | null;
  username: string | null;
  onAuthChanged: (auth: StoredSyncAuth | null, username: string | null) => void;
  onSynced: () => Promise<void>;
  onClose: () => void;
}

export function Sync({ auth, username, onAuthChanged, onSynced, onClose }: Props) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Carries the auth the server redirected us to, so the full sync that
  // follows goes to the same host the normal sync was told to use.
  const [pendingFull, setPendingFull] = useState<{
    outcome: Extract<SyncOutcome, { kind: "needsFullSync" }>;
    auth: StoredSyncAuth;
  } | null>(null);

  const signIn = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const stored = await login({
          username: user,
          password,
          endpoint: endpoint.trim() || undefined,
        });
        setPassword("");
        onAuthChanged(stored, user);
        setMessage("Signed in.");
      } catch (err) {
        setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [user, password, endpoint, onAuthChanged],
  );

  const runSync = useCallback(async () => {
    if (!auth) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { outcome, auth: current } = await syncCollection(auth);
      // The server may have moved us to a different host; keep that.
      if (current !== auth) {
        onAuthChanged(current, username);
      }
      if (outcome.kind === "done") {
        setMessage(outcome.message);
        await onSynced();
      } else {
        setPendingFull({ outcome, auth: current });
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [auth, username, onAuthChanged, onSynced]);

  const confirmFull = useCallback(
    async (direction: "upload" | "download") => {
      const target = pendingFull?.auth ?? auth;
      if (!target) return;
      setBusy(true);
      setError(null);
      setPendingFull(null);
      try {
        await fullSync(target, direction);
        if (direction === "download") {
          // A full download brings the collection but can leave its images
          // and fonts behind; fetch those before showing any cards.
          setMessage("Collection downloaded. Fetching media…");
          await syncMedia(target);
        }
        setMessage(
          direction === "upload"
            ? "Uploaded this device's collection to AnkiWeb."
            : "Replaced this device's collection with AnkiWeb's, including media.",
        );
        await onSynced();
      } catch (err) {
        setError(describe(err));
      } finally {
        setBusy(false);
      }
    },
    [auth, pendingFull, onSynced],
  );

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await logout();
      onAuthChanged(null, null);
      setMessage("Signed out.");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }, [onAuthChanged]);

  return (
    <div className="wrap">
      <header className="head">
        <button className="link" onClick={onClose}>
          ‹ Decks
        </button>
        <h1>AnkiWeb</h1>
      </header>

      {error && <p className="error">{error}</p>}
      {message && !pendingFull && <p className="notice">{message}</p>}

      {pendingFull && (
        <div className="card danger">
          <h2>One collection must replace the other</h2>
          <p>{pendingFull.outcome.message}</p>
          <p className="warn">
            This cannot be undone. Whichever side you do not keep loses its changes.
          </p>
          <div className="confirm-actions">
            {pendingFull.outcome.direction !== "download" && (
              <button
                className="destructive"
                disabled={busy}
                onClick={() => void confirmFull("upload")}
              >
                Keep this device
              </button>
            )}
            {pendingFull.outcome.direction !== "upload" && (
              <button
                className="destructive"
                disabled={busy}
                onClick={() => void confirmFull("download")}
              >
                Keep AnkiWeb
              </button>
            )}
            <button className="link" disabled={busy} onClick={() => setPendingFull(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {auth ? (
        <div className="card">
          <h2>Account</h2>
          <p className="sub">Signed in{username ? ` as ${username}` : ""}.</p>
          <div className="confirm-actions">
            <button onClick={() => void runSync()} disabled={busy}>
              {busy ? "Syncing…" : "Sync now"}
            </button>
            <button className="link" onClick={() => void signOut()} disabled={busy}>
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <form className="card" onSubmit={(e) => void signIn(e)}>
          <h2>Sign in</h2>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label>
            Server <span className="hint">optional, for a self-hosted sync server</span>
            <input
              type="url"
              placeholder="https://sync.ankiweb.net"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !user || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="hint">
            Your password is exchanged for a sync key and is not stored.
          </p>
        </form>
      )}
    </div>
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
