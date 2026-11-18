'use client';

import { use, useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const FUEL_NAMES: Record<string, string> = { SP: 'Super sans plomb', GO: 'Gasoil', PL: 'Pétrole' };

interface Instruction {
  station: { code: string; name: string };
  items: { fuel: string; price: number; prev: number | null }[];
  applyAt: string | null;
  expiresAt: string;
  status: string;
  confirmedAt: string | null;
  confirmation: { problems?: string[]; comment?: string | null } | null;
  canConfirmFrom: string | null;
}

const fmt = (d: string) =>
  new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Abidjan', dateStyle: 'full', timeStyle: 'short' });

/** Page du gérant de station (phase 0), ouverte depuis le lien reçu par SMS ou WhatsApp. */
export default function ManagerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Instruction | null>(null);
  const [error, setError] = useState('');
  const [totem, setTotem] = useState<Record<string, string>>({});
  const [pump, setPump] = useState<Record<string, string>>({});
  const [totemPhoto, setTotemPhoto] = useState<File | null>(null);
  const [pumpPhoto, setPumpPhoto] = useState<File | null>(null);
  const [comment, setComment] = useState('');
  const [problemMode, setProblemMode] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/m/${token}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.message ?? 'Lien invalide');
        setData(b);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  async function submit() {
    if (!data) return;
    setError('');
    for (const i of data.items) {
      if (!totem[i.fuel] || !pump[i.fuel]) return setError('Indiquez les prix lus sur le totem et sur la pompe.');
    }
    if (!totemPhoto || !pumpPhoto) return setError('Les deux photos sont obligatoires.');
    const f = new FormData();
    f.set('totem', JSON.stringify(Object.fromEntries(data.items.map((i) => [i.fuel, Number(totem[i.fuel])]))));
    f.set('pump', JSON.stringify(Object.fromEntries(data.items.map((i) => [i.fuel, Number(pump[i.fuel])]))));
    if (comment) f.set('comment', comment);
    f.set('totemPhoto', totemPhoto);
    f.set('pumpPhoto', pumpPhoto);
    setBusy(true);
    try {
      const r = await fetch(`${API}/m/${token}/confirm`, { method: 'POST', body: f });
      const b = await r.json();
      if (!r.ok) throw new Error(b.message ?? 'Envoi impossible');
      setData(b);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reportProblem() {
    if (!comment.trim()) return setError('Décrivez le problème.');
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${API}/m/${token}/problem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.message ?? 'Envoi impossible');
      setData(b);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <main className="narrow"><div className="card err">{error}</div></main>;
  if (!data) return <main className="narrow"><div className="muted">Chargement…</div></main>;

  const done = ['applied', 'partially_applied', 'failed'].includes(data.status);
  const closed = ['superseded', 'unconfirmed', 'expired'].includes(data.status) || new Date(data.expiresAt) < new Date();
  const tooEarly = data.canConfirmFrom && new Date(data.canConfirmFrom) > new Date();

  return (
    <main className="narrow">
      <h1>{data.station.code}</h1>
      <div className="muted" style={{ marginBottom: 12 }}>{data.station.name}</div>

      <section className="card">
        <h2>Nouveaux prix à appliquer</h2>
        <div style={{ marginBottom: 10 }}>
          {data.applyAt ? <>À partir du <b>{fmt(data.applyAt)}</b></> : <b>Dès maintenant</b>}
        </div>
        <table>
          <thead><tr><th>Produit</th><th className="num">Ancien</th><th className="num">Nouveau (FCFA/L)</th></tr></thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.fuel}>
                <td>{FUEL_NAMES[i.fuel] ?? i.fuel}</td>
                <td className="num muted">{i.prev ?? '—'}</td>
                <td className="num"><b style={{ fontSize: 20 }}>{i.price}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 8 }}>Changez le prix sur les pompes et sur le totem au même moment.</div>
      </section>

      {done && (
        <section className="card">
          <span className={`pill ${data.status === 'applied' ? 'ok' : data.status === 'failed' ? 'bad' : 'warn'}`}>
            {data.status === 'applied' ? 'Confirmé, merci' : data.status === 'failed' ? 'Problème signalé' : 'Confirmé avec un écart'}
          </span>
          {data.confirmation?.problems?.length ? <ul>{data.confirmation.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
          <div className="muted" style={{ marginTop: 6 }}>Le siège a été informé.</div>
        </section>
      )}

      {!done && closed && <div className="card warn">Cette consigne n'est plus valable : elle a expiré ou une consigne plus récente l'a remplacée.</div>}

      {!done && !closed && tooEarly && (
        <div className="card info">Vous pourrez confirmer à partir du {fmt(data.canConfirmFrom!)}. Ne changez pas les prix avant l'heure.</div>
      )}

      {!done && !closed && !tooEarly && !problemMode && (
        <section className="card">
          <h2>Confirmer le changement</h2>
          {data.items.map((i) => (
            <div key={i.fuel} className="row" style={{ marginBottom: 10 }}>
              <div>
                <label htmlFor={`t-${i.fuel}`}>{FUEL_NAMES[i.fuel] ?? i.fuel} lu sur le totem</label>
                <input id={`t-${i.fuel}`} inputMode="numeric" value={totem[i.fuel] ?? ''} style={{ width: 150 }}
                  onChange={(e) => setTotem({ ...totem, [i.fuel]: e.target.value.replace(/\D/g, '') })} />
              </div>
              <div>
                <label htmlFor={`p-${i.fuel}`}>{FUEL_NAMES[i.fuel] ?? i.fuel} lu sur une pompe</label>
                <input id={`p-${i.fuel}`} inputMode="numeric" value={pump[i.fuel] ?? ''} style={{ width: 150 }}
                  onChange={(e) => setPump({ ...pump, [i.fuel]: e.target.value.replace(/\D/g, '') })} />
              </div>
            </div>
          ))}
          <div style={{ marginBottom: 10 }}>
            <label htmlFor="ph-t">Photo du totem</label>
            <input id="ph-t" type="file" accept="image/*" capture="environment" onChange={(e) => setTotemPhoto(e.target.files?.[0] ?? null)} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label htmlFor="ph-p">Photo de l'afficheur d'une pompe</label>
            <input id="ph-p" type="file" accept="image/*" capture="environment" onChange={(e) => setPumpPhoto(e.target.files?.[0] ?? null)} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="cm">Remarque (facultatif)</label>
            <input id="cm" style={{ width: '100%' }} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="row">
            <button className="primary" onClick={submit} disabled={busy}>{busy ? 'Envoi…' : 'Envoyer la confirmation'}</button>
            <button onClick={() => { setProblemMode(true); setError(''); }}>Je n'y arrive pas</button>
          </div>
        </section>
      )}

      {!done && !closed && problemMode && (
        <section className="card">
          <h2>Signaler un problème</h2>
          <label htmlFor="pb">Que se passe-t-il ?</label>
          <textarea id="pb" rows={4} style={{ width: '100%' }} value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="ex. la télécommande du totem ne fonctionne pas" />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={reportProblem} disabled={busy}>Envoyer au siège</button>
            <button onClick={() => setProblemMode(false)}>Retour</button>
          </div>
        </section>
      )}

      {error && <div className="err">{error}</div>}
    </main>
  );
}
