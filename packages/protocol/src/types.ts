export const PROTOCOL_VERSION = 1 as const;

/** Code produit : SP (super sans plomb), GO (gasoil), PL (pétrole lampant)… */
export type FuelCode = string;

export interface PriceItem {
  fuel: FuelCode;
  /** Nouveau prix, FCFA par litre, entier. */
  price: number;
  /** Prix précédent connu du cloud, pour information et contrôle. */
  prev: number | null;
}

export interface PriceCommand {
  v: typeof PROTOCOL_VERSION;
  type: 'set_prices';
  cmd_id: string;
  /** Numéro croissant par boîtier : une commande plus ancienne ne peut pas écraser une plus récente. */
  seq: number;
  tenant: string;
  station: string;
  gw: string;
  issued_at: string;
  /** Heure d'application (ISO 8601 UTC) ou null pour « dès réception ». */
  apply_at: string | null;
  /** Au-delà, le boîtier refuse la commande. */
  expires_at: string;
  items: PriceItem[];
  sig: string;
}

export const ACK_STATUSES = [
  'received', // reçue et vérifiée, écrite en file locale
  'scheduled', // en attente de l'heure d'application
  'totem_applied', // totem écrit et relu
  'applied', // totem et pompes (ou contrôleur) confirmés
  'partially_applied', // au moins un équipement en échec
  'rejected', // signature, bornes, format…
  'expired', // reçue après expires_at
  'superseded', // une commande plus récente a déjà été appliquée
  'failed', // échec définitif après les essais locaux
] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

/** Statuts après lesquels le cloud n'attend plus rien du boîtier. */
export const FINAL_ACK_STATUSES: readonly AckStatus[] = [
  'applied',
  'partially_applied',
  'rejected',
  'expired',
  'superseded',
  'failed',
];

export interface DeviceResult {
  device: string; // "totem", "pump-1", "controller"…
  ok: boolean;
  error?: string;
}

export interface CommandAck {
  v: typeof PROTOCOL_VERSION;
  cmd_id: string;
  gw: string;
  status: AckStatus;
  at: string;
  reason?: string;
  duplicate?: boolean;
  devices?: DeviceResult[];
  /** Prix effectivement relus sur l'équipement. */
  applied?: Record<FuelCode, number>;
  sig: string;
}

export interface GatewayState {
  v: typeof PROTOCOL_VERSION;
  gw: string;
  online: boolean;
  at: string;
  last_seq?: number;
  prices?: Record<FuelCode, number>;
  pending?: number;
  fw?: string;
}
