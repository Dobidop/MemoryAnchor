// The reviewer: fetching the due queue, rendering cards through Anki's own
// template engine, and answering them.
//
// Scheduling is entirely rslib's. getQueuedCards hands back the four states a
// card would move to for each rating; answering just returns the chosen one.
// Nothing here reimplements FSRS, and nothing here should.

import { create } from "@bufbuild/protobuf";
import {
  RenderCardResponseSchema,
  RenderExistingCardRequestSchema,
  type RenderCardResponse,
} from "../gen/anki/card_rendering_pb.js";
import { OpChangesSchema } from "../gen/anki/collection_pb.js";
import {
  CardAnswerSchema,
  CardAnswer_Rating,
  GetQueuedCardsRequestSchema,
  QueuedCardsSchema,
  type SchedulingStates,
} from "../gen/anki/scheduler_pb.js";
import { call } from "./client.js";

export type Rating = "again" | "hard" | "good" | "easy";

const RATINGS: Record<Rating, CardAnswer_Rating> = {
  again: CardAnswer_Rating.AGAIN,
  hard: CardAnswer_Rating.HARD,
  good: CardAnswer_Rating.GOOD,
  easy: CardAnswer_Rating.EASY,
};

export interface QueueCounts {
  new: number;
  learning: number;
  review: number;
}

export interface CurrentCard {
  cardId: bigint;
  states: SchedulingStates;
  counts: QueueCounts;
}

/** The next due card, or null when the deck is finished for now. */
export async function nextCard(): Promise<CurrentCard | null> {
  const queued = await call(
    "getQueuedCards",
    GetQueuedCardsRequestSchema,
    create(GetQueuedCardsRequestSchema, { fetchLimit: 1, intradayLearningOnly: false }),
    QueuedCardsSchema,
  );

  const counts: QueueCounts = {
    new: queued.newCount,
    learning: queued.learningCount,
    review: queued.reviewCount,
  };

  const first = queued.cards[0];
  if (!first?.card || !first.states) {
    return null;
  }
  return { cardId: first.card.id, states: first.states, counts };
}

export interface RenderedCard {
  question: string;
  answer: string;
  css: string;
}

/**
 * Anki returns a card as a list of nodes: literal template text interleaved
 * with field replacements. Concatenating them yields the HTML it would show.
 */
function nodesToHtml(nodes: RenderCardResponse["questionNodes"]): string {
  let html = "";
  for (const node of nodes) {
    if (node.value.case === "text") {
      html += node.value.value;
    } else if (node.value.case === "replacement") {
      html += node.value.value.currentText;
    }
  }
  return html;
}

export async function renderCard(cardId: bigint): Promise<RenderedCard> {
  const rendered = await call(
    "renderExistingCard",
    RenderExistingCardRequestSchema,
    create(RenderExistingCardRequestSchema, { cardId, browser: false, partialRender: false }),
    RenderCardResponseSchema,
  );
  return {
    question: nodesToHtml(rendered.questionNodes),
    answer: nodesToHtml(rendered.answerNodes),
    css: rendered.css,
  };
}

/**
 * Grades a card. `millisecondsTaken` feeds Anki's statistics, so it is worth
 * passing honestly rather than zero.
 */
export async function answerCard(
  card: CurrentCard,
  rating: Rating,
  millisecondsTaken: number,
): Promise<void> {
  const next = card.states[rating];
  if (!card.states.current || !next) {
    throw new Error(`backend returned no '${rating}' state for card ${card.cardId}`);
  }
  await call(
    "answerCard",
    CardAnswerSchema,
    create(CardAnswerSchema, {
      cardId: card.cardId,
      currentState: card.states.current,
      newState: next,
      rating: RATINGS[rating],
      answeredAtMillis: BigInt(Date.now()),
      millisecondsTaken: Math.max(0, Math.round(millisecondsTaken)),
    }),
    OpChangesSchema,
  );
}
