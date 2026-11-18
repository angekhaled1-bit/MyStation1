import { Injectable, Logger } from '@nestjs/common';
import { DbService } from './db/db.service.js';

export interface OutgoingMessage {
  tenantId: string;
  commandId?: string;
  recipient: string;
  body: string;
  /** Partie secrète du message (lien avec jeton), masquée dans le journal en base. */
  secret?: string;
}

/**
 * Envoi des consignes aux gérants de station.
 * NOTIFY_PROVIDER :
 *   log      (défaut) affiche le message dans la console de l'API — développement uniquement ;
 *   webhook  envoie {to, body} en JSON à NOTIFY_WEBHOOK_URL (passerelle SMS/WhatsApp de l'opérateur,
 *            outil d'automatisation…), avec l'en-tête Authorization: Bearer NOTIFY_WEBHOOK_TOKEN si défini.
 */
@Injectable()
export class NotifierService {
  private readonly log = new Logger('Notifier');
  private readonly provider = process.env.NOTIFY_PROVIDER ?? 'log';
  /** Derniers messages envoyés, en mémoire, pour les tests et la démonstration. */
  readonly recent: OutgoingMessage[] = [];

  constructor(private readonly db: DbService) {}

  async send(m: OutgoingMessage): Promise<boolean> {
    let status = 'sent';
    let error: string | null = null;
    try {
      if (this.provider === 'webhook') {
        const url = process.env.NOTIFY_WEBHOOK_URL;
        if (!url) throw new Error('NOTIFY_WEBHOOK_URL manquant');
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.NOTIFY_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.NOTIFY_WEBHOOK_TOKEN}` } : {}),
          },
          body: JSON.stringify({ to: m.recipient, body: m.body }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`passerelle : HTTP ${r.status}`);
      } else {
        this.log.log(`→ ${m.recipient} : ${m.body}`);
      }
    } catch (e) {
      status = 'failed';
      error = (e as Error).message;
      this.log.warn(`échec d'envoi à ${m.recipient} : ${error}`);
    }
    this.recent.push(m);
    if (this.recent.length > 100) this.recent.shift();
    const redacted = m.secret ? m.body.split(m.secret).join('[lien masqué]') : m.body;
    await this.db.query(
      'insert into notifications(tenant_id, command_id, channel, recipient, body, status, error) values ($1, $2, $3, $4, $5, $6, $7)',
      [m.tenantId, m.commandId ?? null, this.provider, m.recipient, redacted, status, error],
    );
    return status === 'sent';
  }
}
