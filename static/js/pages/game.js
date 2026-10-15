import { api, h, esc, fmtDate, resultClass, resultLabel, COLOR_LABEL, toast, scrollWithin, params } from '../util.js';
import { Board, arrow, moveUci, Chess } from '../board.js';
import { enginePanel, evalBarHtml, setEvalBar } from '../engineview.js';
import { RC, RC_ORDER, rcIcon, buildComments, robotSvg, fmtSpent, fmtClock, HEAT_HOT, HEAT_CRAZY } from '../coach.js';

/** Score approximatif (pions, point de vue des Blancs) à partir d'un % de gain. */
function wpToLabel(wp) {
  if (wp >= 99.5) return '#';
  if (wp <= 0.5) return '-#';
  const x = (wp - 50) / 50;
  const cp = -Math.log(2 / (x + 1) - 1) / 0.00368208;
  return (cp / 100).toFixed(1);
}

function hashStr(s) { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) | 0; return x; }

export async function render(view, gid) {
  let g = await api(`/api/games/${encodeURIComponent(gid)}`);
  const seed = hashStr(gid);
  const opp = g.my_color === 'white' ? `${g.black} (${g.black_elo})` : `${g.white} (${g.white_elo})`;
  view.append(h(`<div class="page-head"><a class="btn btn-ghost icon-btn" href="#/games" title="Retour">←</a>
    <h1>contre ${esc(opp)}</h1><span class="res ${resultClass(g.my_score)}">${resultLabel(g.my_score)}</span>
    <span class="muted">${esc(COLOR_LABEL[g.my_color])} · ${fmtDate(g.played_at)} · ${esc(g.time_class)} · ${esc(g.opening)}</span>
    <div class="spacer"></div><a class="btn btn-sm" href="${esc(g.url)}" target="_blank">Voir sur Chess.com ↗</a></div>`));

  const wrap = h(`<div class="study">
    <div class="board-col">
      <div class="player" data-pos="top"></div>
      <div class="board-row">${evalBarHtml()}<div class="b-holder"><div class="b"></div><div class="sq-badge" hidden></div></div></div>
      <div class="player" data-pos="bottom"></div>
      <div class="board-controls">
        <button class="btn icon-btn" data-a="prevKey" title="Coup charnière précédent (PageUp)">⏮</button><button class="btn icon-btn" data-a="prev" title="Reculer (←)">◀</button>
        <button class="btn icon-btn" data-a="next" title="Avancer (→)">▶</button><button class="btn icon-btn" data-a="nextKey" title="Coup charnière suivant (PageDown)">⏭</button>
        <div class="spacer"></div><button class="btn btn-sm" data-a="flip">Retourner</button>
        <button class="btn btn-sm btn-primary" data-a="rep">Ouvrir dans le répertoire</button>
      </div>
      <div class="var-bar" hidden><span class="var-tag">Variante</span><div class="var-line"></div><button class="btn btn-sm btn-ghost" data-v="exit" title="Revenir à la partie (Échap)">↩ Partie</button></div>
      <div class="coach"><div class="coach-side"><div class="coach-bot"></div><div class="heat" title="Chauffe : monte avec les coups marquants"><div class="heat-fill"></div></div></div><div class="coach-bubble"><div class="coach-head"></div><div class="coach-text"></div></div></div>
    </div>
    <div class="side">
      <div class="review-progress panel" hidden></div>
      <div class="info"></div>
      <div class="panel" id="summary"></div>
      <div class="panel"><div class="eval-graph" id="graph"></div></div>
      <div class="panel"><div class="panel-title"><h2>Coups</h2></div><div class="movelist"></div></div>
      <div class="panel"><div class="panel-title"><h2>Stockfish</h2><div class="spacer"></div><span class="small muted" id="engDepth"></span></div><div id="eng"></div></div>
    </div></div>`);
  view.append(wrap);

  const board = new Board(wrap.querySelector('.b'), { orientation: g.my_color, onMove: (uci, san, m) => playVar(m) });
  const evalEl = wrap.querySelector('.evalbar');
  evalEl.classList.toggle('flip', g.my_color === 'black');
  const engine = enginePanel(wrap.querySelector('#eng'), wrap.querySelector('#engDepth'), board,
    uci => { const m = board.play(uci); if (m) playVar(m); }, null, evalEl);
  const ml = wrap.querySelector('.movelist');
  const badge = wrap.querySelector('.sq-badge');
  const varBar = wrap.querySelector('.var-bar');
  let moves = g.moves;
  let comments = [];
  let cur = 0;
  // Variante : coups joués à la main depuis la position `cur` de la partie (vcur = nombre de coups affichés)
  let vline = [], vcur = 0;
  const inVar = () => vline.length > 0;
  let thr = { inaccuracy: 10, mistake: 15, blunder: 25 };
  api('/api/config').then(c => { thr = c.thresholds; }).catch(() => {});

  // ---------------------------------------------------------------- Rendu des données

  function renderData() {
    moves = g.moves;
    comments = buildComments(g, seed);
    // Bilan : précision + nombre de coups par catégorie
    const me = g.my_color, them = me === 'white' ? 'black' : 'white';
    const s = g.summary;
    const cc = { [me]: g.cc_acc_me, [them]: g.cc_acc_opp };
    const accCell = side => `<div class="acc ${side === me ? 'me' : ''}"><div class="acc-val">${s[side].accuracy ?? '–'}</div><div class="small muted">${side === me ? 'Toi' : 'Adversaire'} · ${COLOR_LABEL[side]}</div>${cc[side] != null ? `<div class="cc">Chess.com : ${cc[side].toFixed(1)}</div>` : ''}</div>`;
    const rows = RC_ORDER.map(k => `<tr><td class="num">${s[me].counts[k] || 0}</td><td>${rcIcon(k)} ${RC[k].label}</td><td class="num">${s[them].counts[k] || 0}</td></tr>`).join('');
    wrap.querySelector('#summary').innerHTML = `<div class="panel-title"><h2>Bilan de la partie</h2><div class="spacer"></div><span class="small muted">précision</span></div>
      <div class="acc-row">${accCell(me)}${accCell(them)}</div>
      <table class="t rc-table"><tbody>${rows}</tbody></table>`;

    // Liste des coups (icône pour les coups notables)
    ml.innerHTML = '';
    const repPly = g.rep && (g.rep.type === 'deviation' || g.rep.type === 'uncovered') ? g.rep.ply : null;
    moves.forEach((m, i) => {
      if (i % 2 === 0) ml.append(h(`<div class="n">${i / 2 + 1}.</div>`));
      const show = m.rc && !['best', 'excellent', 'good'].includes(m.rc);
      const el = h(`<div class="mv${m.loss == null ? ' out' : ''}" data-i="${i + 1}">${show ? rcIcon(m.rc, 'sm') : ''}${esc(m.san)}${m.spent != null ? `<span class="mv-t">${fmtSpent(m.spent)}</span>` : ''}${i === repPly ? ' <span class="badge ' + (g.rep.type === 'deviation' ? 'mistake' : 'info') + '" style="font-size:10px">rép.</span>' : ''}</div>`);
      el.onclick = () => go(i + 1);
      ml.append(el);
    });

    renderGraph();

    const r = g.rep;
    let html = '';
    if (r) {
      if (r.type === 'deviation') html = `<div class="banner deviation">Au coup ${Math.floor(r.ply / 2) + 1}, tu as joué <b>${esc(r.san)}</b> alors que ton répertoire prévoit <b>${esc(r.expected.join(' / '))}</b>.</div>`;
      else if (r.type === 'uncovered') html = `<div class="banner uncovered">Au coup ${Math.floor(r.ply / 2) + 1}, ton adversaire a joué <b>${esc(r.san)}</b>, que ton répertoire ne couvre pas encore.</div>`;
      else if (r.type === 'other') html = `<div class="banner">Autre ouverture que ton répertoire (${esc(r.san)} au coup ${Math.floor(r.ply / 2) + 1}).</div>`;
      else html = `<div class="banner end">Partie jouée selon ton répertoire jusqu'au coup ${Math.floor(r.ply / 2) + 1}.</div>`;
    }
    wrap.querySelector('.info').innerHTML = html;
  }

  // Courbe d'évaluation (% de gain des Blancs) ; les coups charnières sont marqués d'un point
  function renderGraph() {
    const el = wrap.querySelector('#graph');
    const n = moves.length;
    if (!n) { el.innerHTML = ''; return; }
    const pts = [[0, moves[0].wp_before != null ? moves[0].wp_before : 50]];
    moves.forEach((m, i) => {
      if (m.wp_after != null) pts.push([i + 1, m.side === 'white' ? m.wp_after : 100 - m.wp_after]);
    });
    const poly = `0,100 ${pts.map(([x, w]) => `${x},${100 - w}`).join(' ')} ${pts[pts.length - 1][0]},100`;
    const dots = moves.map((m, i) => m.key && m.wp_after != null
      ? `<span class="g-dot" style="left:${100 * (i + 1) / n}%;top:${100 - (m.side === 'white' ? m.wp_after : 100 - m.wp_after)}%;background:${RC[m.rc].color}" title="${Math.floor(i / 2) + 1}${i % 2 ? '…' : '.'}${esc(m.san)} — ${RC[m.rc].label}" data-i="${i + 1}"></span>` : '').join('');
    el.innerHTML = `<svg viewBox="0 0 ${n} 100" preserveAspectRatio="none"><polygon points="${poly}" fill="#dcdcde"/><line x1="0" y1="50" x2="${n}" y2="50" stroke="#6c6c74" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>
      ${dots}<div class="g-cursor"></div>`;
    el.onclick = e => {
      const d = e.target.closest('.g-dot');
      if (d) return go(+d.dataset.i);
      const r = el.getBoundingClientRect();
      go(Math.round((e.clientX - r.left) / r.width * n));
    };
  }

  // ---------------------------------------------------------------- Navigation

  function squarePos(sq) {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    const white = board.cg.state.orientation === 'white';
    return { x: white ? f : 7 - f, y: white ? 7 - r : r };
  }
  function hideBadge() { badge.hidden = true; }
  function showBadge(m) {
    if (!m || !RC[m.rc]) return hideBadge();
    const { x, y } = squarePos(m.uci.slice(2, 4));
    badge.innerHTML = rcIcon(m.rc, 'lg');
    badge.style.left = `${(x + 1) * 12.5}%`;
    badge.style.top = `${y * 12.5}%`;
    badge.hidden = false;
  }

  // Bandeaux joueurs + pendule (temps restant dans la position affichée)
  function renderPlayers() {
    const bottom = board.cg.state.orientation;
    const n = moves.length;
    const toMove = !inVar() && cur < n ? (cur % 2 === 0 ? 'white' : 'black') : null;
    for (const el of wrap.querySelectorAll('.player')) {
      const side = el.dataset.pos === 'bottom' ? bottom : (bottom === 'white' ? 'black' : 'white');
      let clock = g.base_time;
      for (let j = cur - 1; j >= 0; j--) {
        if ((j % 2 === 0) === (side === 'white')) { if (moves[j].clock != null) clock = moves[j].clock; break; }
      }
      const low = g.base_time && clock != null && clock < Math.max(15, g.base_time * 0.07);
      el.innerHTML = `<span class="p-dot ${side}"></span><span class="p-name">${esc(g[side])}</span>
        <span class="muted small">${g[side + '_elo'] ?? ''}</span>${side === g.my_color ? '<span class="p-me">toi</span>' : ''}
        <div class="spacer"></div>${clock != null ? `<span class="p-clock${toMove === side ? ' active' : ''}${low ? ' low' : ''}">${fmtClock(clock)}</span>` : ''}`;
    }
  }

  // Défilement animé vers un coup charnière
  let anim = null;
  function stopAnim() {
    if (!anim) return;
    clearTimeout(anim.timer);
    const t = anim.target;
    anim = null;
    return t;
  }
  function go(n) { stopAnim(); exitVar(); show(n); }

  /** light = étape intermédiaire du défilement : échiquier, liste, pendules, éval seulement. */
  function show(n, light = false) {
    cur = Math.max(0, Math.min(moves.length, n));
    board.setMoves(moves.slice(0, cur).map(m => m.uci));
    ml.querySelectorAll('.mv').forEach(el => { el.classList.toggle('cur', +el.dataset.i === cur); el.classList.remove('branch'); });
    scrollWithin(ml, ml.querySelector('.mv.cur'));
    const gc = wrap.querySelector('.g-cursor');
    if (gc) gc.style.left = `${100 * cur / moves.length}%`;

    const m = moves[cur - 1];
    if (light) {
      board.shapes([]);
      hideBadge();
      let wp = 50;
      if (m && m.wp_after != null) wp = m.side === 'white' ? m.wp_after : 100 - m.wp_after;
      setEvalBar(evalEl, wp, wpToLabel(wp));
      renderPlayers();
      return;
    }
    // Flèche verte du meilleur coup quand le coup joué ne l'était pas
    board.shapes(m && m.best_uci && m.uci !== m.best_uci && !['book', 'best', 'excellent'].includes(m.rc) ? [arrow(m.best_uci, 'green')] : []);
    showBadge(m);

    // Barre d'éval (valeur stockée), puis affinée par l'analyse en direct
    let wpWhite = 50;
    if (m && m.wp_after != null) wpWhite = m.side === 'white' ? m.wp_after : 100 - m.wp_after;
    else if (!m && moves[0] && moves[0].wp_before != null) wpWhite = moves[0].wp_before;
    setEvalBar(evalEl, wpWhite, wpToLabel(wpWhite));

    renderPlayers();

    // Coach
    const c = comments[cur] || { text: '', mood: 'neutral' };
    wrap.querySelector('.coach-bot').innerHTML = robotSvg(c.mood);
    wrap.querySelector('.coach').className = `coach mood-${c.mood}`;
    const heat = c.heat || 0;
    const hf = wrap.querySelector('.heat-fill');
    hf.style.width = `${Math.max(heat, 2)}%`;
    wrap.querySelector('.heat').className = `heat${heat >= HEAT_CRAZY ? ' crazy' : heat >= HEAT_HOT ? ' hot' : ''}`;
    wrap.querySelector('.coach-head').innerHTML = m && m.rc
      ? `${rcIcon(m.rc)} <b>${esc(m.san)}</b> <span class="muted">· ${RC[m.rc].label}${m.loss >= 1 && m.rc !== 'book' ? ` · -${m.loss.toFixed(0)} %` : ''}</span>`
        + (m.spent != null ? `<div class="spacer"></div><span class="muted small" title="Temps passé sur le coup · restant">⏱ ${fmtSpent(m.spent)} · ${fmtClock(m.clock)}</span>` : '') : '';
    wrap.querySelector('.coach-text').textContent = c.text;

    engine.load(board.fen(), 250);
  }

  function jumpKey(dir) {
    const pending = stopAnim();
    if (pending != null) show(pending, true);
    const keys = moves.map((m, i) => m.key ? i + 1 : null).filter(x => x != null);
    const target = dir > 0 ? keys.find(k => k > cur) : [...keys].reverse().find(k => k < cur);
    if (target == null) { if (pending != null) show(pending); toast(dir > 0 ? 'Plus de coup charnière après celui-ci' : 'Pas de coup charnière avant'); return; }
    exitVar();
    // Les coups défilent rapidement jusqu'à la cible (~1,5 s max, quelle que soit la distance)
    const steps = Math.abs(target - cur);
    const delay = Math.max(45, Math.min(150, 1500 / steps));
    const step = () => {
      const n = cur + Math.sign(target - cur);
      if (n === target) { anim = null; show(n); return; }
      show(n, true);
      anim.timer = setTimeout(step, delay);
    };
    anim = { target, timer: setTimeout(step, 0) };
  }

  // ---------------------------------------------------------------- Variante (coups hors partie)
  // On peut jouer d'autres coups depuis n'importe quelle position : Stockfish évalue chaque coup.
  // ← recule dans la variante tant qu'on n'est pas revenu sur la position de la partie ;
  // une fois revenu, la variante est oubliée (→ suit de nouveau la partie).

  function exitVar() { vline = []; vcur = 0; varBar.hidden = true; }

  function playVar(m) {
    stopAnim();
    const uci = moveUci(m);
    if (!inVar() && moves[cur] && moves[cur].uci === uci) { go(cur + 1); return; } // le coup de la partie
    if (vline[vcur] && vline[vcur].uci === uci) vcur++; // même coup que la suite de la variante
    else {
      const e = { uci, san: m.san, before: m.before, after: m.after, rc: null, loss: null, best: null };
      vline = vline.slice(0, vcur);
      vline.push(e);
      vcur++;
      rateVar(e);
    }
    showVar(0);
  }

  function back() {
    if (!inVar()) return go(cur - 1);
    vcur--;
    if (vcur === 0) go(cur); else showVar();
  }
  function fwd() {
    if (!inVar()) return go(cur + 1);
    if (vcur < vline.length) { vcur++; showVar(); }
  }

  /** Classe le coup comme ceux de la partie : perte de % de gain par rapport au meilleur coup. */
  async function rateVar(e) {
    try {
      const b = await engine.lines(e.before);
      const best = b.lines[0];
      if (!best) throw new Error('aucune ligne');
      // Coup parmi les lignes principales : même recherche, comparaison directe
      const own = b.lines.find(l => l.uci === e.uci);
      const mates = new Chess(e.after).isCheckmate();
      let loss;
      if (mates) loss = 0;
      else if (own) loss = best.wp - own.wp;
      else {
        const a = await engine.lines(e.after);
        loss = best.wp - (a.lines.length ? 100 - a.lines[0].wp : 50);
      }
      // Mater, ou jouer un coup aussi fort que le 1er choix de Stockfish (autre mat en 1…), c'est le meilleur coup
      const top = mates || e.uci === best.uci || (own && own.cp === best.cp && own.mate === best.mate);
      e.loss = top ? 0 : Math.max(0, loss);
      e.best = best.uci;
      e.rc = top ? 'best' : e.loss >= thr.blunder ? 'blunder' : e.loss >= thr.mistake ? 'mistake'
        : e.loss >= thr.inaccuracy ? 'inaccuracy' : e.loss < 2 ? 'excellent' : 'good';
    } catch {
      e.failed = true;
    }
    if (!vline.includes(e)) return;
    renderVarBar();
    if (vline[vcur - 1] === e) renderVarMove();
  }

  function showVar(delay = 250) {
    board.setMoves([...moves.slice(0, cur).map(m => m.uci), ...vline.slice(0, vcur).map(v => v.uci)]);
    // Dans la liste, la position de départ de la variante reste repérée
    ml.querySelectorAll('.mv').forEach(el => { el.classList.remove('cur'); el.classList.toggle('branch', +el.dataset.i === cur); });
    renderPlayers();
    renderVarBar();
    renderVarMove();
    // Le coach ne commente pas les variantes (pour l'instant)
    wrap.querySelector('.coach-bot').innerHTML = robotSvg('neutral');
    wrap.querySelector('.coach').className = 'coach mood-neutral';
    wrap.querySelector('.coach-text').textContent = '';
    engine.load(board.fen(), delay);
  }

  function renderVarBar() {
    varBar.hidden = false;
    varBar.querySelector('.var-line').innerHTML = vline.map((v, k) => {
      const ply = cur + k;
      const num = ply % 2 === 0 ? `${ply / 2 + 1}.` : k === 0 ? `${(ply + 1) / 2}…` : '';
      const icon = v.rc && !['best', 'excellent', 'good'].includes(v.rc) ? rcIcon(v.rc, 'sm') : '';
      return `${num ? `<span class="num">${num}</span>` : ''}<span class="vm${k + 1 === vcur ? ' cur' : ''}${k >= vcur ? ' ahead' : ''}" data-k="${k + 1}">${icon}${esc(v.san)}</span>`;
    }).join('');
  }

  function renderVarMove() {
    const e = vline[vcur - 1];
    board.shapes(e.best && e.uci !== e.best && !['best', 'excellent'].includes(e.rc) ? [arrow(e.best, 'green')] : []);
    showBadge(e);
    wrap.querySelector('.coach-head').innerHTML = e.rc
      ? `${rcIcon(e.rc)} <b>${esc(e.san)}</b> <span class="muted">· ${RC[e.rc].label}${e.loss >= 1 ? ` · -${e.loss.toFixed(0)} %` : ''}</span>`
      : `<b>${esc(e.san)}</b>${e.failed ? '' : ' <span class="muted small"><span class="spin"></span> Stockfish évalue le coup…</span>'}`;
  }

  varBar.onclick = e => {
    if (e.target.closest('[data-v="exit"]')) return go(cur);
    const vm = e.target.closest('.vm');
    if (vm) { vcur = +vm.dataset.k; showVar(); }
  };

  wrap.querySelector('.board-controls').onclick = e => {
    const a = e.target.dataset.a;
    if (a === 'prevKey') jumpKey(-1);
    if (a === 'prev') back();
    if (a === 'next') fwd();
    if (a === 'nextKey') jumpKey(1);
    if (a === 'flip') { board.flip(); evalEl.classList.toggle('flip'); showBadge(inVar() ? vline[vcur - 1] : moves[cur - 1]); renderPlayers(); }
    if (a === 'rep') {
      const sans = [...moves.slice(0, cur).map(m => m.san), ...vline.slice(0, vcur).map(v => v.san)];
      location.hash = `#/repertoire/${g.my_color}?san=${encodeURIComponent(sans.join(','))}`;
    }
  };
  const key = e => {
    if (e.key === 'ArrowLeft') back();
    if (e.key === 'ArrowRight') fwd();
    if (e.key === 'Escape' && inVar()) go(cur);
    if (e.key === 'Home') go(0);
    if (e.key === 'End') go(moves.length);
    if (e.key === 'PageUp') { e.preventDefault(); jumpKey(-1); }
    if (e.key === 'PageDown') { e.preventDefault(); jumpKey(1); }
  };
  window.addEventListener('keydown', key);

  // ---------------------------------------------------------------- Analyse complète (une fois par partie)

  let poll = null, alive = true;
  async function ensureReview() {
    const prog = wrap.querySelector('.review-progress');
    let st = await api(`/api/review?gid=${encodeURIComponent(gid)}`);
    if (st.reviewed) return;
    if (!st.running) st = await api(`/api/review?gid=${encodeURIComponent(gid)}`, { method: 'POST' });
    prog.hidden = false;
    const tick = async () => {
      if (!alive) return;
      st = await api(`/api/review?gid=${encodeURIComponent(gid)}`);
      if (st.error) { prog.textContent = `Erreur d'analyse : ${st.error}`; return; }
      prog.innerHTML = `<div class="small"><span class="spin"></span> Analyse complète de la partie… ${st.done}/${st.total || '?'}</div>
        <div class="progress"><div style="width:${st.total ? 100 * st.done / st.total : 0}%"></div></div>`;
      if (st.reviewed && !st.running) {
        prog.hidden = true;
        g = await api(`/api/games/${encodeURIComponent(gid)}`);
        if (!alive) return;
        renderData();
        if (inVar()) showVar(); else go(cur);
        return;
      }
      poll = setTimeout(tick, 1000);
    };
    tick();
  }

  renderData();
  go(+(params().get('ply') || 0));
  ensureReview();
  return () => { stopAnim(); alive = false; clearTimeout(poll); window.removeEventListener('keydown', key); engine.destroy(); board.destroy(); };
}
