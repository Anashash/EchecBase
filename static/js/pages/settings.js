import { api, h, esc, toast } from '../util.js';
import { pollStatus } from '../app.js';

export async function render(view) {
  const c = await api('/api/config');
  view.append(h(`<div class="page-head"><h1>Réglages</h1></div>`));
  const f = h(`<div class="panel"><div class="form">
    <h2 style="grid-column:1/-1;margin-top:4px">Comptes</h2>
    <label>Pseudo Chess.com <span class="muted">(profil actif)</span></label><input type="text" name="chesscom_username" value="${esc(c.chesscom_username)}">
    <label>Jeton Lichess (explorateur)</label><input type="password" name="lichess_token" value="${esc(c.lichess_token)}" placeholder="lip_…" autocomplete="off">
    <div class="help">Nécessaire pour l'explorateur d'ouvertures. Crée-le sur lichess.org → Préférences → Jetons d'accès API (aucune permission à cocher). Il reste stocké sur ton PC uniquement (commun à tous les profils, jamais exporté).</div>

    <h2 style="grid-column:1/-1;margin-top:14px">Import <span class="muted small" style="font-weight:400">· profil actif</span></h2>
    <label>Mois à importer</label><input type="number" name="import_months" min="1" max="120" value="${c.import_months}">
    <label>Cadences</label><div>${['bullet', 'blitz', 'rapid', 'daily'].map(t => `<label class="check" style="margin-right:12px"><input type="checkbox" name="tc" value="${t}" ${c.time_classes.includes(t) ? 'checked' : ''}> ${{ bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapide', daily: 'Par jour' }[t]}</label>`).join('')}</div>

    <h2 style="grid-column:1/-1;margin-top:14px">Analyse</h2>
    <label>Demi-coups analysés par partie</label><input type="number" name="analysis_plies" min="10" max="120" value="${c.analysis_plies}">
    <div class="help">30 demi-coups = les 15 premiers coups de chaque camp.</div>
    <label>Analyse complète automatique</label><label class="check"><input type="checkbox" name="auto_review" ${c.auto_review ? 'checked' : ''}> Analyser toutes les parties en entier pendant la synchro</label>
    <div class="help">Nécessaire pour la précision, les coups brillants et les gaffes dans la liste des parties. Environ 1 minute par partie, en tâche de fond.</div>
    <label>Limiter l'analyse complète <span class="muted">(profil actif)</span></label><div style="display:flex;gap:8px;align-items:center"><input type="number" name="review_months" min="0" max="120" value="${c.review_months}" style="width:90px"><span class="muted">derniers mois · 0 = toutes les parties</span></div>
    <div class="help">Les parties plus anciennes gardent l’analyse des débuts ; l’analyse complète d’une partie se lance quand même si tu ouvres sa page.</div>
    <label>Profondeur (analyse des parties)</label><input type="number" name="analysis_depth" min="8" max="30" value="${c.analysis_depth}">
    <label>Profondeur (répertoire)</label><input type="number" name="live_depth" min="10" max="35" value="${c.live_depth}">
    <label>Threads Stockfish (fond / interactif)</label><div style="display:flex;gap:8px"><input type="number" name="engine_threads" min="1" max="64" value="${c.engine_threads}"><input type="number" name="live_threads" min="1" max="64" value="${c.live_threads}"></div>

    <h2 style="grid-column:1/-1;margin-top:14px">Seuils (perte de % de chances de gain)</h2>
    <label>Imprécision / erreur / gaffe</label><div style="display:flex;gap:8px"><input type="number" name="t_inaccuracy" value="${c.thresholds.inaccuracy}"><input type="number" name="t_mistake" value="${c.thresholds.mistake}"><input type="number" name="t_blunder" value="${c.thresholds.blunder}"></div>
    <label>Niveaux de l'explorateur</label><input type="text" name="explorer_ratings" value="${c.explorer_ratings.join(', ')}">
    <div class="help">Tranches Elo Lichess : 0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500.</div>

    <div></div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-primary" id="save">Enregistrer</button><button class="btn" id="reana">Réanalyser toutes les parties</button></div>
  </div></div>`);
  view.append(f);

  const val = n => f.querySelector(`[name=${n}]`).value;
  f.querySelector('#save').onclick = async () => {
    const body = {
      chesscom_username: val('chesscom_username').trim(),
      lichess_token: val('lichess_token').trim(),
      import_months: +val('import_months'),
      time_classes: [...f.querySelectorAll('[name=tc]:checked')].map(x => x.value),
      auto_review: f.querySelector('[name=auto_review]').checked,
      review_months: Math.max(0, +val('review_months') || 0),
      analysis_plies: +val('analysis_plies'), analysis_depth: +val('analysis_depth'), live_depth: +val('live_depth'),
      engine_threads: +val('engine_threads'), live_threads: +val('live_threads'),
      thresholds: { inaccuracy: +val('t_inaccuracy'), mistake: +val('t_mistake'), blunder: +val('t_blunder') },
      explorer_ratings: val('explorer_ratings').split(/[,\s]+/).filter(Boolean).map(Number),
    };
    await api('/api/config', { body });
    toast('Réglages enregistrés');
  };
  f.querySelector('#reana').onclick = async () => {
    if (!confirm('Relancer l’analyse Stockfish de toutes les parties ? (utile après avoir changé la profondeur ou le nombre de coups analysés)')) return;
    try { await api('/api/reanalyse', { method: 'POST' }); pollStatus(); toast('Analyse relancée'); }
    catch (e) { toast(e.message); }
  };
}
