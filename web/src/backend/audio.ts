// Card audio playback.
//
// Played from the app rather than inside the card iframe: the reviewer needs
// to stop the previous card's audio when moving on, and a sandboxed frame is
// awkward to reach into. Sound files come from the media route; {{tts}} tags
// go to the device's speech synthesis, which is what Anki does on mobile.

import { config, mediaToken } from "./client.js";
import type { Playable } from "./review.js";

let current: HTMLAudioElement | null = null;
let generation = 0;

function mediaUrl(filename: string): string {
  const { baseUrl } = config();
  return `${baseUrl}/_anchor/media/${encodeURIComponent(mediaToken())}/${encodeURIComponent(filename)}`;
}

/** Stops anything currently playing. Safe to call when nothing is. */
export function stop(): void {
  generation += 1;
  if (current) {
    current.pause();
    current.src = "";
    current = null;
  }
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
}

function playFile(filename: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(mediaUrl(filename));
    current = audio;
    // A missing or unplayable file should not stall the queue.
    const done = () => resolve();
    audio.addEventListener("ended", done, { once: true });
    audio.addEventListener("error", done, { once: true });
    audio.play().catch(done);
  });
}

function speak(item: Extract<Playable, { kind: "tts" }>): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined") {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = item.lang;
    utterance.rate = item.speed;
    utterance.addEventListener("end", () => resolve(), { once: true });
    utterance.addEventListener("error", () => resolve(), { once: true });
    speechSynthesis.speak(utterance);
  });
}

/**
 * Plays a card side's audio in order, as Anki does.
 *
 * Any later call supersedes this one, so moving to the next card does not
 * leave the previous card still talking.
 */
export async function playAll(items: Playable[]): Promise<void> {
  stop();
  const mine = generation;
  for (const item of items) {
    if (mine !== generation) return;
    await (item.kind === "file" ? playFile(item.filename) : speak(item));
  }
}
