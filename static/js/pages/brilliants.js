import { api, h, esc, fmtDate, lineText, resultClass, resultLabel, COLOR_LABEL } from '../util.js';
import { miniBoard, arrow } from '../board.js';
import { rcIcon, RC } from '../coach.js';

let kind = 'brilliant';

export async function render(view) {
  view.append(h(`<div class="page-head"><a class="btn btn-ghost icon-btn" href="#/" title="Retour">←</a><h1>Tes plus beaux coups</h1>
    <div class="seg" id="kind"><button data-v="brilliant">${rcIcon('brilliant', 'sm')} Brillants</button><button data-v="great">${rcIcon('great', 'sm')} Très bons coups</button></div></div>`));
  const intro = h(`<div class="notice" style="margin-bottom:14px"></div>`);
  const list = h(`<div class="cards"></div>`);
  view.append(intro, list);

  const load = async () => {
    view.querySelectorAll('#kind button').forEach(b => b.classList.toggle('on', b.dataset.v === kind));
    intro.innerHTML = kind === 'brilliant'
      ? `<b>Brillant</b> : un sacrifice de pièce correct, trouvé alors que la partie n'était pas déjà gagnée.`
      : `<b>Très bon coup</b> : le seul coup qui tenait la position, tous les autres perdaient nettement.`;
    list.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    const items = await api(`/api/special?rc=${kind}`);
    list.innerHTML = '';
    if (!items.length) list.append(h(`<div class="empty">Aucun pour l'instant. Ils apparaissent au fur et à mesure de l'analyse complète de tes parties.</div>`));
    for (const it of items) {
      const opp = it.my_color === 'white' ? `${it.black} (${it.black_elo})` : `${it.white} (${it.white_elo})`;
      const moveNo = `${Math.floor(it.ply / 2) + 1}${it.ply % 2 ? '…' : '.'}${it.san}`;
      const el = h(`<div class="pcard">
        <div class="mini"><div class="b"></div></div>
        <div class="body">
          <div class="head">${rcIcon(kind)}<h3>${esc(moveNo)}</h3><span class="badge">${RC[kind].label}</span>
            <span class="muted small">contre ${esc(opp)} · ${fmtDate(it.played_at)} · ${esc(it.time_class)}</span>
            <span class="res ${resultClass(it.my_score)} small">${resultLabel(it.my_score)}</span></div>
          <div class="small muted">${esc(lineText(it.line.slice(-8), it.line.length - Math.min(8, it.line.length)))}</div>
          <div class="small muted">${esc(it.opening)} · ${COLOR_LABEL[it.my_color]}</div>
          <div class="actions"><a class="btn btn-sm btn-primary" href="#/game/${encodeURIComponent(it.game_id)}?ply=${it.ply + 1}">Voir dans la partie</a></div>
        </div></div>`);
      list.append(el);
      miniBoard(el.querySelector('.b'), it.fen, it.my_color, [arrow(it.uci, kind === 'brilliant' ? 'teal' : 'blue')]);
    }
  };
  view.querySelector('#kind').onclick = e => { const b = e.target.closest('button'); if (b) { kind = b.dataset.v; load(); } };
  await load();
}
