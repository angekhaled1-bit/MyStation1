import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandAck, PriceCommand } from '@fpc/protocol';

export interface GatewayData {
  /** Plus grand seq appliqué : toute commande de seq inférieur ou égal est périmée. */
  lastAppliedSeq: number;
  /** Dernier prix valide confirmé sur le totem. */
  lastValid: Record<string, number>;
  /** Commandes acceptées et pas encore terminées (survivent à une coupure). */
  queue: PriceCommand[];
  /** Dernier accusé connu par cmd_id, pour répondre aux doublons sans réécrire. */
  seen: Record<string, CommandAck>;
}

const MAX_SEEN = 500;

export interface Store {
  data: GatewayData;
  save(): void;
}

export function emptyData(initialPrices: Record<string, number> = {}): GatewayData {
  return { lastAppliedSeq: 0, lastValid: { ...initialPrices }, queue: [], seen: {} };
}

/** Stockage en mémoire, pour les tests. */
export function memoryStore(data: GatewayData = emptyData()): Store {
  return { data, save() {} };
}

/**
 * Stockage sur fichier : écriture dans un fichier temporaire, fsync, puis renommage atomique.
 * Une coupure pendant l'écriture laisse l'ancien fichier intact.
 */
export function fileStore(path: string, initialPrices: Record<string, number>): Store {
  mkdirSync(dirname(path), { recursive: true });
  let data: GatewayData;
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as GatewayData;
  } catch {
    data = emptyData(initialPrices);
  }
  return {
    data,
    save() {
      const ids = Object.keys(data.seen);
      if (ids.length > MAX_SEEN) for (const id of ids.slice(0, ids.length - MAX_SEEN)) delete data.seen[id];
      const tmp = path + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 1));
      const fd = openSync(tmp, 'r');
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, path);
    },
  };
}
