import { api, h, esc, pct, fmtDate, scoreBar, COLOR_LABEL, lineText } from '../util.js';
import { miniBoard, arrow } from '../board.js';
import { rcIcon } from '../coach.js';
import { onSyncDone, startSync } from '../app.js';

export async function render(view) {
  const [ov, probs, ops, dev, reps] = await Promise.all([
    api('/api/overview'), api('/api/problems?limit=4&min_seen=2'), api('/api/openings'),
    api('/api/deviations'),
    Promise.all([api('/api/repertoire/white'), api('/api/repertoire/black')]),
  ]);

  const head = h(`<div class="page-head"><h1>Tableau de bord</h1><div class="spacer"></div>
    ${ov.games ? `<span class="muted small">${ov.games} parties · du ${fmtDate(ov.first)} au ${fmtDate(ov.last)}</span>` : ''}</div>`);
  view.append(head);

  if (!ov.games) {
    const e = h(`<div class="empty">
      <p>Aucune partie pour l'instant.</p>
      <p class="small">La synchronisation importe tes parties Chess.com (blitz et rapide, 6 derniers mois) puis les analyse avec Stockfish.</p>
      <button class="btn btn-primary">Importer et analyser mes parties</button></div>`);
    e.querySelector('button').onclick = () => startSync(true);
    view.append(e);
    return onSyncDone(() => location.reload());
  }

  const c = ov.by_color;
  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const colorKpi = col => {
    const x = c[col] || {};
    return kpi(`Score avec les ${COLOR_LABEL[col]}`, pct(x.score), `${x.n || 0} parties · ${x.wins || 0} G / ${x.draws || 0} N / ${x.losses || 0} P`);
  };
  const errs = col => {
    const x = c[col] || {};
    return x.analyzed ? ((x.mistakes || 0) / x.analyzed).toFixed(1) : '–';
  };
  const analysedPct = ov.games ? Math.round(100 * ov.analyzed / ov.games) : 0;
  const reviewTxt = `analyse complète : ${ov.review_done}/${ov.review_total}${ov.review_months ? ` (${ov.review_months} dernier${ov.review_months > 1 ? 's' : ''} mois)` : ''}`;
  view.append(h(`<div class="kpis">
    ${kpi(`Débuts analysés <span class="muted">(${Math.ceil(ov.plies / 2)} premiers coups)</span>`, `${ov.analyzed}<span class="muted" style="font-size:15px"> / ${ov.games}</span>`, `${analysedPct < 100 ? `${analysedPct} % — lance une synchro pour terminer` : 'À jour'} · ${reviewTxt}`)}
    ${colorKpi('white')}${colorKpi('black')}
    ${kpi("Erreurs d'ouverture / partie", `${errs('white')} <span class="muted" style="font-size:15px">·</span> ${errs('black')}`, 'Blancs · Noirs (erreurs + gaffes)')}
    <a class="kpi" href="#/brilliants" title="Voir tous tes coups brillants"><div class="label">Coups brillants</div><div class="value">${rcIcon('brilliant')}${ov.brilliant}</div><div class="sub">${ov.great} très bons coups · ${ov.reviewed} partie${ov.reviewed > 1 ? 's' : ''} analysée${ov.reviewed > 1 ? 's' : ''} en entier</div></a>
    ${kpi('Répertoire', `${reps[0].summary.lines + reps[1].summary.lines}`, `lignes · suivi dans ${dev.total ? Math.round(100 * dev.followed / dev.total) : 0} % des parties`)}
  </div>`));

  const grid = h(`<div class="grid cols-2"></div>`);
  view.append(grid);

  // Positions à travailler
  const pPanel = h(`<div class="panel"><div class="panel-title"><h2>Positions qui te coûtent le plus</h2><div class="spacer"></div><a class="btn btn-sm btn-ghost" href="#/problems">Tout voir →</a></div><div class="cards"></div></div>`);
  const cards = pPanel.querySelector('.cards');
  if (!probs.length) cards.append(h(`<div class="empty small">Aucune position rencontrée au moins 2 fois avec une faute${ov.analyzed < ov.games ? ' (analyse en cours)' : ''}.</div>`));
  for (const p of probs) {
    const worst = p.played.find(x => x.cls) || p.played[0];
    const el = h(`<a class="pcard" href="#/repertoire/${p.color}?san=${encodeURIComponent(p.line.join(','))}" style="padding:10px">
      <div class="mini" style="width:120px"><div class="b"></div></div>
      <div class="body" style="gap:4px">
        <div class="head"><span class="dot ${p.color}"></span><span class="small muted">${esc(lineText(p.line.slice(-6), p.line.length - Math.min(6, p.line.length)))}</span></div>
        <div>Tu joues <b>${esc(worst.san)}</b> <span class="badge ${worst.cls || ''}">${worst.cls ? '-' + worst.avg_loss.toFixed(0) + ' %' : 'ok'}</span> · Stockfish : <b class="star">${esc(p.best_san || '?')}</b></div>
        <div class="small muted">Rencontrée ${p.n} fois · faute ${p.faults} fois · score ${pct(p.score)}</div>
      </div></a>`);
    cards.append(el);
    miniBoard(el.querySelector('.b'), p.fen, p.color, [arrow(worst.uci, 'red'), ...(p.best_uci ? [arrow(p.best_uci, 'green')] : [])]);
  }
  grid.append(pPanel);

  // Ouvertures
  const top = ops.slice(0, 12);
  const oPanel = h(`<div class="panel"><div class="panel-title"><h2>Tes ouvertures</h2></div>
    <table class="t"><thead><tr><th></th><th>Ouverture</th><th class="num">Parties</th><th>Score</th><th class="num">Erreurs/partie</th></tr></thead><tbody></tbody></table></div>`);
  const tb = oPanel.querySelector('tbody');
  for (const o of top) {
    tb.append(h(`<tr><td><span class="dot ${o.color}"></span></td><td>${esc(o.opening || '—')}</td><td class="num">${o.games}</td>
      <td><div style="display:flex;gap:8px;align-items:center"><div class="bar" style="width:70px"><div style="width:${100 * o.score}%"></div></div><span class="small">${pct(o.score)}</span></div></td>
      <td class="num ${o.errors_per_game >= 1 ? 'tag-todo' : ''}">${o.errors_per_game == null ? '<span class="muted">–</span>' : o.errors_per_game.toFixed(1)}</td></tr>`));
  }
  grid.append(oPanel);

  // Hors répertoire
  if (dev.items.length) {
    const dPanel = h(`<div class="panel" style="grid-column:1/-1"><div class="panel-title"><h2>Sorties de répertoire les plus fréquentes</h2><div class="spacer"></div><a class="btn btn-sm btn-ghost" href="#/problems?tab=uncovered">Tout voir →</a></div>
      <table class="t"><thead><tr><th></th><th>Ligne</th><th>Événement</th><th class="num">Parties</th><th class="num">Score</th></tr></thead><tbody></tbody></table></div>`);
    const tb2 = dPanel.querySelector('tbody');
    for (const d of dev.items.slice(0, 6)) {
      const tr = h(`<tr class="click"><td><span class="dot ${d.color}"></span></td><td class="small">${esc(lineText(d.line))}</td>
        <td>${d.type === 'deviation' ? `<span class="badge mistake">Tu as joué ${esc(d.san)}</span> au lieu de <b>${esc(d.expected.join(' / '))}</b>` : `<span class="badge info">${esc(d.san)} non préparé</span>`}</td>
        <td class="num">${d.n}</td><td class="num">${pct(d.score)}</td></tr>`);
      tr.onclick = () => location.hash = `#/repertoire/${d.color}?san=${encodeURIComponent(d.line.join(','))}`;
      tb2.append(tr);
    }
    grid.append(dPanel);
  }

  return onSyncDone(() => { if (location.hash === '' || location.hash === '#/') window.dispatchEvent(new HashChangeEvent('hashchange')); });
}
