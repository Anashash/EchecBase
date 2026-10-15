import { api, h, esc, pct, lineText, params, COLOR_LABEL } from '../util.js';
import { miniBoard, arrow } from '../board.js';

const state = { tab: 'pos', color: '', repeated: false };

export async function render(view) {
  const p = params();
  if (p.get('tab')) state.tab = p.get('tab') === 'rep' ? 'uncovered' : p.get('tab');
  view.append(h(`<div class="page-head"><h1>Points faibles</h1>
    <div class="seg" id="tab"><button data-v="pos">Positions coûteuses</button><button data-v="deviation">Mes écarts<span class="count" id="cDev"></span></button><button data-v="uncovered">Coups non prévus<span class="count" id="cUnc"></span></button></div>
    <div class="spacer"></div>
    <label class="check" id="rpt"><input type="checkbox"> Fautes répétées seulement</label>
    <div class="seg" id="col"><button data-v="">Toutes</button><button data-v="white">Blancs</button><button data-v="black">Noirs</button></div></div>`));
  const intro = h(`<div class="notice" style="margin-bottom:14px"></div>`);
  const list = h(`<div class="cards"></div>`);
  view.append(intro, list);

  const load = async () => {
    view.querySelectorAll('#tab button').forEach(b => b.classList.toggle('on', b.dataset.v === state.tab));
    view.querySelectorAll('#col button').forEach(b => b.classList.toggle('on', b.dataset.v === state.color));
    view.querySelector('#rpt').hidden = state.tab !== 'pos';
    view.querySelector('#rpt input').checked = state.repeated;
    list.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    if (state.tab === 'pos') {
      intro.innerHTML = `Positions de tes parties où tu te trompes, les plus fréquentes d'abord (nombre de fautes, puis chances de gain perdues). Une position revient souvent ? C'est une erreur d'habitude : la corriger rapporte des points à chaque fois. <span class="muted">Flèche rouge : ton coup le plus fréquent · verte : Stockfish.</span>`;
      api(`/api/deviations?color=${state.color}&kind=deviation`).then(d => {
        view.querySelector('#cDev').textContent = d.counts.deviation;
        view.querySelector('#cUnc').textContent = d.counts.uncovered;
      }).catch(() => { });
      const items = await api(`/api/problems?color=${state.color}&min_errors=${state.repeated ? 2 : 1}&limit=60`);
      list.innerHTML = '';
      if (!items.length) list.append(h(`<div class="empty">Aucune position${state.repeated ? ' avec une faute répétée' : ''} pour l'instant.</div>`));
      items.forEach(it => list.append(problemCard(it)));
    } else {
      const isDev = state.tab === 'deviation';
      intro.innerHTML = isDev
        ? `Parties où <b>tu n'as pas joué le coup prévu</b> par ton répertoire, de la plus fréquente à la plus rare. Si tu changes d'ouverture dès tes 2 premiers coups, la partie est considérée comme une autre ouverture et n'apparaît pas ici.`
        : `Coups adverses que <b>ton répertoire ne prévoit pas encore</b>, du plus fréquent au plus rare : ce sont les trous à combler en priorité.`;
      const dev = await api(`/api/deviations?color=${state.color}&kind=${state.tab}`);
      view.querySelector('#cDev').textContent = dev.counts.deviation;
      view.querySelector('#cUnc').textContent = dev.counts.uncovered;
      list.innerHTML = '';
      if (dev.other) list.append(h(`<div class="small muted" style="margin:-4px 0 4px">${dev.other} partie${dev.other > 1 ? 's' : ''} jouée${dev.other > 1 ? 's' : ''} dans une autre ouverture (ignorée${dev.other > 1 ? 's' : ''}).</div>`));
      if (!dev.items.length) list.append(h(`<div class="empty">${!dev.total ? 'Construis ton répertoire pour voir ici où tes parties en sortent.' : isDev ? 'Aucun écart : tu suis ta préparation.' : 'Tous les coups adverses rencontrés sont couverts par ton répertoire.'}</div>`));
      dev.items.forEach(it => list.append(devCard(it)));
    }
  };

  view.querySelector('#tab').onclick = e => { const b = e.target.closest('button'); if (b) { state.tab = b.dataset.v; load(); } };
  view.querySelector('#col').onclick = e => { if (e.target.dataset.v != null) { state.color = e.target.dataset.v; load(); } };
  view.querySelector('#rpt input').onchange = e => { state.repeated = e.target.checked; load(); };
  await load();
}

function repLink(color, line) {
  return `#/repertoire/${color}?san=${encodeURIComponent(line.join(','))}`;
}

function problemCard(p) {
  const worst = p.played.find(x => x.cls) || p.played[0];
  const moveNo = Math.floor(p.line.length / 2) + 1;
  const el = h(`<div class="pcard">
    <div class="mini"><div class="b"></div></div>
    <div class="body">
      <div class="head"><span class="dot ${p.color}"></span><h3>${COLOR_LABEL[p.color]} · coup ${moveNo}</h3>
        ${p.faults >= 2 ? `<span class="badge blunder">Faute répétée ×${p.faults}</span>` : ''}
        <span class="badge">rencontrée ${p.n} fois</span><span class="badge">score ${pct(p.score)}</span></div>
      <div class="small muted">${esc(lineText(p.line))}</div>
      <div class="played">${p.played.map(x => `<span class="chip" title="${x.n} fois · perte moyenne ${x.avg_loss == null ? '?' : x.avg_loss.toFixed(0)} %"><b>${esc(x.san)}</b> ×${x.n}${x.cls ? ` <span class="badge ${x.cls}">-${x.avg_loss.toFixed(0)} %</span>` : ' <span class="badge good">ok</span>'}</span>`).join('')}</div>
      <div>Stockfish recommande <b class="star">${esc(p.best_san || '?')}</b>${p.wp != null ? ` <span class="muted small">(${p.wp.toFixed(0)} % de chances de gain)</span>` : ''}</div>
      <div class="actions">
        <a class="btn btn-sm btn-primary" href="${repLink(p.color, p.line)}">Étudier dans le répertoire</a>
        ${p.games.slice(0, 3).map((g, i) => `<a class="btn btn-sm btn-ghost" href="#/game/${encodeURIComponent(g)}">Partie ${i + 1}</a>`).join('')}
      </div>
    </div></div>`);
  miniBoard(el.querySelector('.b'), p.fen, p.color, [arrow(worst.uci, 'red'), ...(p.best_uci ? [arrow(p.best_uci, 'green')] : [])]);
  return el;
}

function devCard(d) {
  const moveNo = Math.floor(d.ply / 2) + 1;
  const isDev = d.type === 'deviation';
  const shapes = [arrow(d.uci, isDev ? 'red' : 'blue'), ...d.expected_uci.map(u => arrow(u, 'green'))];
  const el = h(`<div class="pcard">
    <div class="mini"><div class="b"></div></div>
    <div class="body">
      <div class="head"><span class="dot ${d.color}"></span><h3>${COLOR_LABEL[d.color]} · coup ${moveNo}</h3>
        ${isDev ? '<span class="badge mistake">Écart</span>' : '<span class="badge info">Non couvert</span>'}
        <span class="badge">${d.n} partie${d.n > 1 ? 's' : ''}</span><span class="badge">score ${pct(d.score)}</span></div>
      <div class="small muted">${esc(lineText(d.line))}</div>
      <div>${isDev ? `Tu as joué <b>${esc(d.san)}</b> au lieu de <b class="star">${esc(d.expected.join(' / '))}</b>.` :
      `Ton adversaire a joué <b>${esc(d.san)}</b>. Ton répertoire ne prévoit que ${esc(d.expected.join(', '))}.`}</div>
      <div class="actions">
        <a class="btn btn-sm btn-primary" href="${repLink(d.color, isDev ? d.line : [...d.line, d.san])}">${isDev ? 'Revoir la ligne' : 'Préparer une réponse'}</a>
        ${d.games.slice(0, 3).map((g, i) => `<a class="btn btn-sm btn-ghost" href="#/game/${encodeURIComponent(g)}">Partie ${i + 1}</a>`).join('')}
      </div>
    </div></div>`);
  miniBoard(el.querySelector('.b'), d.fen, d.color, shapes);
  return el;
}
