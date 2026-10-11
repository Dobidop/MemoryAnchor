// Deck listing with due counts, via Anki's own deck tree.

import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "../gen/anki/generic_pb.js";
import {
  DeckIdSchema,
  DeckTreeNodeSchema,
  DeckTreeRequestSchema,
  type DeckTreeNode,
} from "../gen/anki/decks_pb.js";
import { OpChangesSchema } from "../gen/anki/collection_pb.js";
import { call } from "./client.js";

export interface DeckRow {
  id: bigint;
  name: string;
  level: number;
  /** Counts already have child decks and daily limits applied. */
  newCount: number;
  learnCount: number;
  reviewCount: number;
  totalInDeck: number;
}

export function dueTotal(deck: DeckRow): number {
  return deck.newCount + deck.learnCount + deck.reviewCount;
}

/** Flattens Anki's deck tree into rows, preserving order and depth. */
function flatten(node: DeckTreeNode, into: DeckRow[]): void {
  // The tree is rooted at a nameless node representing the whole collection.
  if (node.name !== "") {
    into.push({
      id: node.deckId,
      name: node.name,
      level: node.level,
      newCount: node.newCount,
      learnCount: node.learnCount,
      reviewCount: node.reviewCount,
      totalInDeck: node.totalInDeck,
    });
  }
  for (const child of node.children) {
    flatten(child, into);
  }
}

export async function deckTree(): Promise<DeckRow[]> {
  const root = await call(
    "deckTree",
    DeckTreeRequestSchema,
    // rslib only computes due counts when `now` is non-zero; left at the
    // default every deck reports zero due.
    create(DeckTreeRequestSchema, { now: BigInt(Math.floor(Date.now() / 1000)) }),
    DeckTreeNodeSchema,
  );
  const rows: DeckRow[] = [];
  flatten(root, rows);
  return rows;
}

/** The reviewer draws from whichever deck is current, so this precedes study. */
export async function setCurrentDeck(deckId: bigint): Promise<void> {
  await call(
    "setCurrentDeck",
    DeckIdSchema,
    create(DeckIdSchema, { did: deckId }),
    OpChangesSchema,
  );
}

export { EmptySchema };
