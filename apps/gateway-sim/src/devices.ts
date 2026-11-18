/**
 * Équipements pilotés par le boîtier. Chaque modèle réel (contrôleur de station, carte de totem)
 * aura son propre pilote implémentant cette interface, une fois sa documentation obtenue.
 */
export interface PriceDevice {
  readonly name: string;
  write(prices: Record<string, number>): Promise<void>;
  read(): Promise<Record<string, number>>;
}

export interface SimFaults {
  /** Le totem ne répond pas aux N premières écritures. */
  totemMuteCount?: number;
  /** Les pompes listées ne répondent jamais (ex. ["pump-2"]). */
  deadPumps?: string[];
  /** Le totem relit un prix différent de celui écrit (afficheur défectueux). */
  totemReadMismatch?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SimulatedDevice implements PriceDevice {
  private prices: Record<string, number>;
  private muteLeft: number;

  constructor(
    readonly name: string,
    initial: Record<string, number>,
    private readonly opts: { latencyMs?: number; muteCount?: number; dead?: boolean; readMismatch?: boolean } = {},
  ) {
    this.prices = { ...initial };
    this.muteLeft = opts.muteCount ?? 0;
  }

  async write(prices: Record<string, number>): Promise<void> {
    await sleep(this.opts.latencyMs ?? 0);
    if (this.opts.dead) throw new Error(`${this.name} : aucune réponse (délai dépassé)`);
    if (this.muteLeft > 0) {
      this.muteLeft--;
      throw new Error(`${this.name} : aucune réponse (délai dépassé)`);
    }
    this.prices = { ...this.prices, ...prices };
  }

  async read(): Promise<Record<string, number>> {
    await sleep(this.opts.latencyMs ?? 0);
    if (this.opts.dead) throw new Error(`${this.name} : aucune réponse (délai dépassé)`);
    if (this.opts.readMismatch) return Object.fromEntries(Object.entries(this.prices).map(([k, v]) => [k, v + 1]));
    return { ...this.prices };
  }

  /** Pour l'affichage et les tests. */
  snapshot(): Record<string, number> {
    return { ...this.prices };
  }
}

export function buildSimulatedDevices(
  initial: Record<string, number>,
  pumpCount: number,
  faults: SimFaults = {},
  latencyMs = 0,
): { totem: SimulatedDevice; pumps: SimulatedDevice[] } {
  const totem = new SimulatedDevice('totem', initial, {
    latencyMs,
    muteCount: faults.totemMuteCount,
    readMismatch: faults.totemReadMismatch,
  });
  const pumps = Array.from({ length: pumpCount }, (_, i) => {
    const name = `pump-${i + 1}`;
    return new SimulatedDevice(name, initial, { latencyMs, dead: faults.deadPumps?.includes(name) });
  });
  return { totem, pumps };
}
