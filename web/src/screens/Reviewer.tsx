// The reviewer. Card HTML comes from Anki's template engine and is rendered in
// a sandboxed iframe: card CSS is arbitrary author CSS and must not leak into
// the app's own styling, and card HTML should not be able to script the shell.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mediaToken } from "../backend/client.js";
import {
  answerCard,
  nextCard,
  renderCard,
  type CurrentCard,
  type QueueCounts,
  type Rating,
  type RenderedCard,
} from "../backend/review.js";

const RATING_LABELS: { rating: Rating; label: string; key: string }[] = [
  { rating: "again", label: "Again", key: "1" },
  { rating: "hard", label: "Hard", key: "2" },
  { rating: "good", label: "Good", key: "3" },
  { rating: "easy", label: "Easy", key: "4" },
];

/** Wraps card HTML so it renders exactly as Anki styled it, and no further. */
function cardDocument(card: RenderedCard, side: "question" | "answer"): string {
  // Templates reference media by bare filename; <base> points those at the
  // media route, with a token in the path since <img> sends no headers. This
  // is the media-only credential: card content can read this URL, and must
  // not gain access to the collection API through it.
  const token = mediaToken();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="/_anchor/media/${encodeURIComponent(token)}/">
<style>
  html, body { margin: 0; padding: 1rem; }
  body { font: 18px/1.5 -apple-system, system-ui, sans-serif; color: #1c1b19; background: #fff; }
  img, video { max-width: 100%; height: auto; }
  @media (prefers-color-scheme: dark) {
    body { color: #f2efe9; background: #201f1c; }
  }
</style>
<style>${card.css}</style>
</head>
<body class="card">${side === "question" ? card.question : card.answer}</body>
</html>`;
}

interface Props {
  deckName: string;
  onFinished: () => void;
}

export function Reviewer({ deckName, onFinished }: Props) {
  const [card, setCard] = useState<CurrentCard | null>(null);
  const [rendered, setRendered] = useState<RenderedCard | null>(null);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef<number>(Date.now());

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await nextCard();
      if (!next) {
        setCard(null);
        setRendered(null);
        return;
      }
      setCard(next);
      setCounts(next.counts);
      setRendered(await renderCard(next.cardId));
      setRevealed(false);
      shownAt.current = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grade = useCallback(
    async (rating: Rating) => {
      if (!card || busy) return;
      setBusy(true);
      setError(null);
      try {
        await answerCard(card, rating, Date.now() - shownAt.current);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [card, busy, load],
  );

  // Space reveals, 1-4 grade — the bindings Anki users already have.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (!revealed) setRevealed(true);
        else void grade("good");
        return;
      }
      if (!revealed) return;
      const match = RATING_LABELS.find((r) => r.key === event.key);
      if (match) {
        event.preventDefault();
        void grade(match.rating);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, grade]);

  const srcDoc = useMemo(
    () => (rendered ? cardDocument(rendered, revealed ? "answer" : "question") : ""),
    [rendered, revealed],
  );

  if (error) {
    return (
      <div className="wrap">
        <p className="error">{error}</p>
        <button onClick={onFinished}>Back to decks</button>
      </div>
    );
  }

  if (!busy && !card) {
    return (
      <div className="wrap">
        <h1>Finished</h1>
        <p className="sub">Nothing left due in {deckName}.</p>
        <button onClick={onFinished}>Back to decks</button>
      </div>
    );
  }

  return (
    <div className="reviewer">
      <header className="reviewer-bar">
        <button className="link" onClick={onFinished} aria-label="Back to decks">
          ‹ Decks
        </button>
        <span className="deck-name">{deckName}</span>
        {counts && (
          <span className="counts" aria-label="remaining cards">
            <em className="new">{counts.new}</em>
            <em className="learning">{counts.learning}</em>
            <em className="review">{counts.review}</em>
          </span>
        )}
      </header>

      <iframe
        className="card-frame"
        title="card"
        // Anki runs card JavaScript and many shared decks depend on it, so
        // allow scripts — but nothing else. Without allow-same-origin the
        // frame keeps an opaque origin and cannot reach this page, its
        // storage, or the API token. The only credential it can see is the
        // media token in the base href, which unlocks media and nothing else.
        //
        // Card scripts can still talk to the outside world, exactly as they
        // can in Anki itself. Locking that down would need a CSP and would
        // diverge from upstream behaviour.
        sandbox="allow-scripts"
        srcDoc={srcDoc}
      />

      <footer className="reviewer-actions">
        {!revealed ? (
          <button className="reveal" onClick={() => setRevealed(true)} disabled={busy}>
            Show answer
          </button>
        ) : (
          <div className="grades">
            {RATING_LABELS.map(({ rating, label }) => (
              <button
                key={rating}
                className={`grade grade-${rating}`}
                onClick={() => void grade(rating)}
                disabled={busy}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}
