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
  /** Leaf name only; the tree already conveys the hierarchy. */
  label: string;
  hasChildren: boolean;
  /** Anki's own collapsed state, so it matches what desktop shows. */
  collapsed: boolean;
  /** Ancestor ids, nearest last — used to hide rows under a collapsed deck. */
  ancestors: bigint[];
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
function flatten(node: DeckTreeNode, into: DeckRow[], ancestors: bigint[]): void {
  // The tree is rooted at a nameless node representing the whole collection.
  if (node.name !== "") {
    into.push({
      id: node.deckId,
      name: node.name,
      label: leafName(node.name),
      level: node.level,
      hasChildren: node.children.length > 0,
      collapsed: node.collapsed,
      ancestors: [...ancestors],
      newCount: node.newCount,
      learnCount: node.learnCount,
      reviewCount: node.reviewCount,
      totalInDeck: node.totalInDeck,
    });
    ancestors = [...ancestors, node.deckId];
  }
  for (const child of node.children) {
    flatten(child, into, ancestors);
  }
}

/// Anki separates deck path components with a unit separator, and the tree
/// already shows the nesting, so only the last component is worth displaying.
export function leafName(name: string): string {
  const parts = name.split("");
  return parts[parts.length - 1] ?? name;
}

/** Hides rows whose ancestor is collapsed, keeping the collapsed deck itself. */
export function visibleDecks(decks: DeckRow[], collapsed: Set<string>): DeckRow[] {
  return decks.filter((deck) => deck.ancestors.every((id) => !collapsed.has(String(id))));
}

/// Due counts already include child decks, so a collapsed parent still shows
/// everything waiting underneath it.
export function initiallyCollapsed(decks: DeckRow[]): Set<string> {
  return new Set(decks.filter((d) => d.collapsed && d.hasChildren).map((d) => String(d.id)));
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
  flatten(root, rows, []);
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
