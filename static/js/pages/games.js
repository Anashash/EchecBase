import { api, h, esc, fmtDate, resultClass, resultLabel } from '../util.js';
import { rcIcon } from '../coach.js';

let filter = { color: '', rep: '' };

function repCell(r) {
  if (!r) return '<span class="muted small">—</span>';
  if (r.type === 'other') return `<span class="muted small" title="Tu as joué ${esc(r.san)} : autre ouverture que ton répertoire">Autre ouverture</span>`;
  if (r.type === 'end') return `<span class="badge good" title="Préparation suivie jusqu'au bout">Suivi</span>`;
  if (r.type === 'deviation') return `<span class="badge mistake" title="Prévu : ${esc(r.expected.join(' / '))}">Écart coup ${Math.floor(r.ply / 2) + 1}</span>`;
  return `<span class="badge info" title="${esc(r.san)} n'est pas couvert par ton répertoire">Non couvert coup ${Math.floor(r.ply / 2) + 1}</span>`;
}

export async function render(view) {
  view.append(h(`<div class="page-head"><h1>Parties</h1><div class="spacer"></div>
    <div class="seg" id="fc"><button data-v="">Toutes</button><button data-v="white">Blancs</button><button data-v="black">Noirs</button></div>
    <div class="seg" id="fr"><button data-v="">Tout</button><button data-v="deviation">Écarts</button><button data-v="uncovered">Non couvert</button><button data-v="err">Avec gaffes</button><button data-v="bril">Brillants</button></div>
  </div>`));
  const panel = h(`<div class="panel" style="padding:6px 8px"><table class="t"><thead><tr>
    <th>Date</th><th></th><th>Adversaire</th><th>Résultat</th><th>Ouverture</th><th class="num">Précision</th><th>Coups</th><th>Répertoire</th><th>Cadence</th></tr></thead><tbody></tbody></table></div>`);
  view.append(panel);
  const tb = panel.querySelector('tbody');
  const all = await api('/api/games');

  const draw = () => {
    view.querySelectorAll('#fc button').forEach(b => b.classList.toggle('on', b.dataset.v === filter.color));
    view.querySelectorAll('#fr button').forEach(b => b.classList.toggle('on', b.dataset.v === filter.rep));
    tb.innerHTML = '';
    const rows = all.filter(g => (!filter.color || g.my_color === filter.color) &&
      (!filter.rep || (filter.rep === 'err' ? (g.reviewed ? g.n_blunder > 0 : g.blunders > 0)
        : filter.rep === 'bril' ? g.n_brilliant > 0 : g.rep && g.rep.type === filter.rep)));
    if (!rows.length) tb.append(h(`<tr><td colspan="9" class="muted" style="padding:20px;text-align:center">Aucune partie</td></tr>`));
    for (const g of rows) {
      const opp = g.my_color === 'white' ? `${g.black} (${g.black_elo})` : `${g.white} (${g.white_elo})`;
      const acc = !g.reviewed || g.acc_me == null ? `<span class="muted small" title="Analyse complète en attente">—</span>`
        : `<span class="acc-pill ${g.acc_me >= 90 ? 'hi' : g.acc_me >= 75 ? 'mid' : 'lo'}" title="Toi ${g.acc_me} · adversaire ${g.acc_opp ?? '–'}${g.cc_acc_me != null ? ` · Chess.com : ${g.cc_acc_me.toFixed(1)}` : ''}">${g.acc_me.toFixed(1)}</span>`;
      const marks = !g.reviewed ? '' : [
        g.n_brilliant ? `<span class="mark-count">${rcIcon('brilliant', 'sm')}${g.n_brilliant > 1 ? '×' + g.n_brilliant : ''}</span>` : '',
        g.n_blunder ? `<span class="mark-count">${rcIcon('blunder', 'sm')}${g.n_blunder > 1 ? '×' + g.n_blunder : ''}</span>` : '',
      ].join('');
      const tr = h(`<tr class="click"><td class="muted">${fmtDate(g.played_at)}</td><td><span class="dot ${g.my_color}"></span></td>
        <td>${esc(opp)}</td><td><span class="res ${resultClass(g.my_score)}">${resultLabel(g.my_score)}</span></td>
        <td class="small">${esc(g.opening)}</td><td class="num">${acc}</td><td>${marks}</td><td>${repCell(g.rep)}</td><td class="muted small">${esc(g.time_class)}</td></tr>`);
      tr.onclick = () => location.hash = `#/game/${encodeURIComponent(g.id)}`;
      tb.append(tr);
    }
  };
  view.querySelector('#fc').onclick = e => { if (e.target.dataset.v != null) { filter.color = e.target.dataset.v; draw(); } };
  view.querySelector('#fr').onclick = e => { if (e.target.dataset.v != null) { filter.rep = e.target.dataset.v; draw(); } };
  draw();
}
