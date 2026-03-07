import type { KbCard } from "@ohmycrab/kb-core";
import { randomUUID } from "node:crypto";

/**
 * 仅用于开发期/演示的内存 KB。
 * 后续会替换为真正的持久化存储（Mongo/Postgres/SQLite等）。
 */
export class MemoryKbStore {
  private cards: KbCard[] = [];

  listCards(): KbCard[] {
    return this.cards;
  }

  upsertCard(input: Omit<KbCard, "id"> & { id?: string }): KbCard {
    const id = input.id ?? randomUUID();
    const card: KbCard = { ...input, id };
    const idx = this.cards.findIndex((c) => c.id === id);
    if (idx >= 0) this.cards[idx] = card;
    else this.cards.push(card);
    return card;
  }
}












