'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const FUEL_NAMES: Record<string, string> = { SP: 'Super sans plomb', GO: 'Gasoil', PL: 'Pétrole' };

interface Station {
  id: string; code: string; name: string; city: string | null; fuels: string[]; gateway_id: string;
  online: boolean; last_seen_at: string | null; prices: Record<string, number>; prices_updated_at: string | null; open_alerts: number;
  mode: 'gateway' | 'manual'; manager_name: string | null; manager_phone: string | null;
  compliant: boolean | null; compliance_issues: string[];
}
interface Grid {
  id: string; effective_at: string; items: { fuel: string; price: number }[]; reference: string | null; status: string;
  created_by: string; validated_by: string | null; price_change_id: string | null; current: boolean;
}
interface PreviewLine { stationCode: string; fuel: string; prev: number | null; next: number; variationPct: number | null; level: 'ok' | 'confirm' | 'block'; gridPrice: number | null }
interface Preview { lines: PreviewLine[]; grid: { reference: string | null } | null; blocked: boolean; requiresConfirmation: boolean; requiresApproval: boolean; thresholds: { confirmPct: number; blockPct: number } }
interface PriceChange {
  id: string; items: { fuel: string; price: number }[]; apply_at: string | null; status: string; created_by: string; approved_by: string | null;
  created_at: string; commands: number; applied: number; problems: number; comment: string | null;
}
interface Alert { id: number; kind: string; message: string; created_at: string; station_code: string | null }

const STATUS: Record<string, [string, string]> = {
  sent: ['Envoyé', 'info'], received: ['Reçu', 'info'], scheduled: ['Programmé', 'info'], totem_applied: ['Totem à jour', 'info'],
  applied: ['Appliqué', 'ok'], partially_applied: ['Partiel', 'warn'], rejected: ['Refusé', 'bad'], expired: ['Expiré', 'bad'],
  superseded: ['Remplacé', 'neu'], failed: ['Échec', 'bad'], unconfirmed: ['Non confirmé', 'bad'],
  pending_approval: ['À valider', 'warn'], dispatched: ['Envoyé', 'info'], cancelled: ['Annulé', 'neu'], validated: ['Validée', 'ok'],
};
const CHANNEL_STATUS: Record<string, string> = { sent: 'Consigne envoyée', received: 'Lien ouvert par le gérant' };

/** Photo de confirmation : chargée avec le jeton, car l'URL n'est pas publique. */
function AuthImage({ src, token, alt }: { src: string; token: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    fetch(src, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b) { u = URL.createObjectURL(b); setUrl(u); } });
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [src, token]);
  return url ? <a href={url} target="_blank" rel="noreferrer"><img className="thumb" src={url} alt={alt} /></a> : <span className="muted">photo…</span>;
}
const Pill = ({ s }: { s: string }) => {
  const [t, c] = STATUS[s] ?? [s, 'neu'];
  return <span className={`pill ${c}`}>{t}</span>;
};
const fmt = (d: string | null) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export default function Home() {
  const [token, setToken] = useState('dev-operator');
  const [stations, setStations] = useState<Station[]>([]);
  const [changes, setChanges] = useState<PriceChange[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [grids, setGrids] = useState<Grid[]>([]);
  const [gridPrices, setGridPrices] = useState<Record<string, string>>({});
  const [gridAt, setGridAt] = useState('');
  const [gridRef, setGridRef] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState('');

  const [selected, setSelected] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [applyAt, setApplyAt] = useState('');
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try { const t = localStorage.getItem('fpc-token'); if (t) setToken(t); } catch {}
  }, []);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const r = await fetch(API + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(Array.isArray(body.message) ? body.message.join(', ') : body.message ?? `Erreur ${r.status}`);
    return body;
  }, [token]);

  const refresh = useCallback(async () => {
    try {
      const [s, c, a, g] = await Promise.all([call('/stations'), call('/price-changes'), call('/alerts'), call('/grids')]);
      setStations(s); setChanges(c); setAlerts(a); setGrids(g); setError('');
      if (detail) setDetail(await call(`/price-changes/${detail.id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [call, detail]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const fuels = useMemo(() => [...new Set(stations.flatMap((s) => s.fuels))], [stations]);

  const input = () => ({
    stationIds: selected.length ? selected : 'all',
    items: fuels.filter((f) => prices[f]?.trim()).map((f) => ({ fuel: f, price: Number(prices[f]) })),
    applyAt: applyAt ? new Date(applyAt).toISOString() : null,
    comment: comment || undefined,
  });

  async function doPreview() {
    setError(''); setPreview(null);
    const body = input();
    if (!body.items.length) return setError('Saisissez au moins un prix.');
    if (body.items.some((i) => !Number.isInteger(i.price) || i.price <= 0)) return setError('Prix entiers en FCFA, supérieurs à zéro.');
    setBusy(true);
    try { setPreview(await call('/price-changes/preview', { method: 'POST', body: JSON.stringify(body) })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function send() {
    setBusy(true); setError('');
    try {
      const pc = await call('/price-changes', { method: 'POST', body: JSON.stringify({ ...input(), confirm: true }) });
      setPreview(null); setPrices({}); setComment(''); setApplyAt('');
      setDetail(pc);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function createGrid() {
    setError('');
    const items = fuels.filter((f) => gridPrices[f]?.trim()).map((f) => ({ fuel: f, price: Number(gridPrices[f]) }));
    if (!items.length || !gridAt) return setError("Saisissez les prix de la grille et sa date d'entrée en vigueur.");
    try {
      await call('/grids', { method: 'POST', body: JSON.stringify({ items, effectiveAt: new Date(gridAt).toISOString(), reference: gridRef || undefined }) });
      setGridPrices({}); setGridAt(''); setGridRef('');
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }

  async function action(path: string) {
    setError('');
    try { const r = await call(path, { method: 'POST' }); if (r?.commands) setDetail(r); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <main>
      <header>
        <div>
          <h1>FuelPrice Control</h1>
          <div className="muted">Pilotage des prix carburant · stations avec boîtier ou gérées par le gérant (phase 0)</div>
        </div>
        <div>
          <label htmlFor="tok">Jeton (développement)</label>
          <select id="tok" value={token} onChange={(e) => { setToken(e.target.value); try { localStorage.setItem('fpc-token', e.target.value); } catch {} }}>
            <option value="dev-operator">Opérateur</option>
            <option value="dev-approver">Valideur</option>
            <option value="dev-admin">Administrateur</option>
          </select>
        </div>
      </header>

      {error && <div className="card err">{error}</div>}

      <section className="card">
        <h2>Stations</h2>
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="Tout sélectionner" checked={selected.length === stations.length && stations.length > 0}
                onChange={(e) => setSelected(e.target.checked ? stations.map((s) => s.id) : [])} /></th>
              <th>Station</th><th>Liaison</th>
              {fuels.map((f) => <th key={f} className="num">{FUEL_NAMES[f] ?? f}</th>)}
              <th>Prix confirmés le</th><th>Grille</th><th>Alertes</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((s) => (
              <tr key={s.id}>
                <td><input type="checkbox" aria-label={s.code} checked={selected.includes(s.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, s.id] : selected.filter((x) => x !== s.id))} /></td>
                <td><b>{s.code}</b><div className="muted">{s.name}</div></td>
                <td>{s.mode === 'manual'
                  ? <><span className="pill neu">Gérant</span><div className="muted">{s.manager_phone ?? 'aucun numéro'}</div></>
                  : <><span className={`pill ${s.online ? 'ok' : 'warn'}`}>{s.online ? 'Boîtier en ligne' : 'Boîtier hors ligne'}</span><div className="muted">{s.gateway_id}</div></>}</td>
                {fuels.map((f) => <td key={f} className="num">{s.prices[f] ?? '—'}</td>)}
                <td className="muted">{fmt(s.prices_updated_at)}</td>
                <td>{s.compliant === null ? <span className="muted">—</span>
                  : s.compliant ? <span className="pill ok">Conforme</span>
                  : <span className="pill bad" title={s.compliance_issues.join('\n')}>Non conforme</span>}</td>
                <td>{s.open_alerts ? <span className="pill bad">{s.open_alerts}</span> : <span className="muted">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 6 }}>Les prix affichés sont ceux confirmés sur place (relus par le boîtier ou déclarés par le gérant avec photos), pas ceux demandés.</div>
      </section>

      <section className="card">
        <h2>Grille officielle</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          {fuels.map((f) => (
            <div key={f}>
              <label htmlFor={`g-${f}`}>{FUEL_NAMES[f] ?? f} (FCFA/L)</label>
              <input id={`g-${f}`} type="number" min={1} step={1} style={{ width: 130 }} value={gridPrices[f] ?? ''}
                onChange={(e) => setGridPrices({ ...gridPrices, [f]: e.target.value })} />
            </div>
          ))}
          <div>
            <label htmlFor="g-at">Entrée en vigueur</label>
            <input id="g-at" type="datetime-local" value={gridAt} onChange={(e) => setGridAt(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label htmlFor="g-ref">Référence (arrêté, communiqué)</label>
            <input id="g-ref" style={{ width: '100%' }} value={gridRef} onChange={(e) => setGridRef(e.target.value)} />
          </div>
          <button onClick={createGrid}>Saisir la grille</button>
        </div>
        {grids.length > 0 && (
          <table>
            <thead><tr><th>En vigueur le</th><th>Prix</th><th>Référence</th><th>Saisie / validée par</th><th>Statut</th><th></th></tr></thead>
            <tbody>
              {grids.map((g) => (
                <tr key={g.id}>
                  <td>{fmt(g.effective_at)}{g.current && <> <span className="pill ok">en vigueur</span></>}</td>
                  <td>{g.items.map((i) => `${i.fuel} ${i.price}`).join(' · ')}</td>
                  <td className="muted">{g.reference ?? ''}</td>
                  <td className="muted">{g.created_by}{g.validated_by ? ` / ${g.validated_by}` : ''}</td>
                  <td><Pill s={g.status} />{g.price_change_id && <> <span className="pill info">diffusée</span></>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {g.status === 'pending_approval' && <button onClick={() => action(`/grids/${g.id}/approve`)}>Valider</button>}{' '}
                    {g.status === 'validated' && !g.price_change_id && <button className="primary" onClick={() => action(`/grids/${g.id}/dispatch`)}>Diffuser à toutes les stations</button>}{' '}
                    {!g.price_change_id && g.status !== 'cancelled' && <button onClick={() => action(`/grids/${g.id}/cancel`)}>Annuler</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="muted" style={{ marginTop: 6 }}>Une grille saisie doit être validée par une autre personne. Une fois en vigueur, tout prix différent est bloqué.</div>
      </section>

      <section className="card">
        <h2>Nouveau changement de prix {selected.length ? `(${selected.length} station${selected.length > 1 ? 's' : ''})` : '(toutes les stations)'}</h2>
        <div className="row">
          {fuels.map((f) => (
            <div key={f}>
              <label htmlFor={`p-${f}`}>{FUEL_NAMES[f] ?? f} (FCFA/L)</label>
              <input id={`p-${f}`} type="number" min={1} step={1} style={{ width: 140 }} value={prices[f] ?? ''}
                onChange={(e) => { setPrices({ ...prices, [f]: e.target.value }); setPreview(null); }} />
            </div>
          ))}
          <div>
            <label htmlFor="at">Application (vide : immédiate)</label>
            <input id="at" type="datetime-local" value={applyAt} onChange={(e) => { setApplyAt(e.target.value); setPreview(null); }} />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="cm">Motif</label>
            <input id="cm" style={{ width: '100%' }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="ex. arrêté du …" />
          </div>
          <button onClick={doPreview} disabled={busy}>Vérifier</button>
        </div>

        {preview && (
          <div style={{ marginTop: 14 }}>
            <h2>Récapitulatif</h2>
            <table>
              <thead><tr><th>Station</th><th>Produit</th><th className="num">Actuel</th><th className="num">Nouveau</th><th className="num">Variation</th>{preview.grid && <th className="num">Grille</th>}<th></th></tr></thead>
              <tbody>
                {preview.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.stationCode}</td><td>{FUEL_NAMES[l.fuel] ?? l.fuel}</td>
                    <td className="num">{l.prev ?? '—'}</td><td className="num">{l.next}</td>
                    <td className="num">{l.variationPct === null ? '—' : `${l.variationPct > 0 ? '+' : ''}${l.variationPct} %`}</td>
                    {preview.grid && <td className="num">{l.gridPrice ?? '—'}</td>}
                    <td><span className={`pill ${l.level === 'ok' ? 'ok' : l.level === 'confirm' ? 'warn' : 'bad'}`}>
                      {l.level === 'ok' ? 'OK' : l.level === 'confirm' ? 'À confirmer' : 'Bloqué'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 10 }}>
              {preview.blocked ? (
                <span className="pill bad">{preview.grid ? 'Prix différent de la grille officielle : envoi impossible.' : `Variation supérieure à ${preview.thresholds.blockPct} % : envoi impossible.`}</span>
              ) : (
                <>
                  {preview.requiresConfirmation && <span className="pill warn">Variation supérieure à {preview.thresholds.confirmPct} % : vérifiez avant d'envoyer.</span>}
                  {preview.requiresApproval && <span className="pill info">Une seconde personne devra valider.</span>}
                  <button className="primary" onClick={send} disabled={busy}>
                    {preview.requiresApproval ? 'Soumettre à validation' : 'Confirmer et envoyer'}
                  </button>
                </>
              )}
              <button onClick={() => setPreview(null)}>Annuler</button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Alertes ouvertes</h2>
        {alerts.length === 0 ? <div className="muted">Aucune alerte.</div> : (
          <table>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmt(a.created_at)}</td>
                  <td>{a.message}</td>
                  <td><button onClick={() => action(`/alerts/${a.id}/resolve`)}>Clore</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Historique des changements</h2>
        <table>
          <thead><tr><th>Créé le</th><th>Prix</th><th>Application</th><th>Par</th><th>Statut</th><th>Stations</th><th></th></tr></thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.id}>
                <td className="muted">{fmt(c.created_at)}</td>
                <td>{c.items.map((i) => `${i.fuel} ${i.price}`).join(' · ')}</td>
                <td className="muted">{c.apply_at ? fmt(c.apply_at) : 'immédiate'}</td>
                <td className="muted">{c.created_by}{c.approved_by ? ` / ${c.approved_by}` : ''}</td>
                <td><Pill s={c.status} /></td>
                <td>{c.commands ? <>{c.applied}/{c.commands} appliqués{c.problems ? <> · <span className="pill bad">{c.problems} en échec</span></> : null}</> : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button onClick={async () => setDetail(await call(`/price-changes/${c.id}`))}>Détail</button>{' '}
                  {c.status === 'pending_approval' && <>
                    <button onClick={() => action(`/price-changes/${c.id}/approve`)}>Valider</button>{' '}
                    <button onClick={() => action(`/price-changes/${c.id}/cancel`)}>Annuler</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detail && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Suivi par station</h2>
            <button onClick={() => setDetail(null)}>Fermer</button>
          </div>
          <table>
            <thead><tr><th>Station</th><th>Liaison</th><th>Statut</th><th>Détail</th><th>Mis à jour</th></tr></thead>
            <tbody>
              {detail.commands.map((c: any) => (
                <tr key={c.id}>
                  <td>{c.station_code}</td>
                  <td className="muted">{c.channel === 'manual' ? 'Gérant' : `Boîtier (${c.attempts} envoi${c.attempts > 1 ? 's' : ''})`}</td>
                  <td>{c.channel === 'manual' && CHANNEL_STATUS[c.status] ? <span className="pill info">{CHANNEL_STATUS[c.status]}</span> : <Pill s={c.status} />}</td>
                  <td className="muted">
                    {c.status_detail ?? ''}
                    {c.confirmation?.comment && <div>Gérant : « {c.confirmation.comment} »</div>}
                    {c.photos?.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        {c.photos.map((p: any) => (
                          <AuthImage key={p.id} token={token} alt={p.kind} src={`${API}/commands/${c.cmd_id}/photos/${p.id}`} />
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="muted">{fmt(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.commands.length === 0 && <div className="muted">Aucune commande envoyée (en attente de validation ou annulée).</div>}
        </section>
      )}
    </main>
  );
}
