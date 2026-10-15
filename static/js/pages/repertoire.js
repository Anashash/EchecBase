import { api, h, esc, pct, params, fmtEval, toast, COLOR_LABEL, scrollWithin } from '../util.js';
import { Board, Chess, keyOf, replay, arrow, moveUci } from '../board.js';
import { enginePanel, evalBarHtml } from '../engineview.js';

export async function render(view, color) {
  const other = color === 'white' ? 'black' : 'white';
  let rep = await api(`/api/repertoire/${color}`);
  let graph = buildGraph(rep.edges);

  view.append(h(`<div class="page-head"><h1>Répertoire</h1>
    <div class="seg"><a href="#/repertoire/white"><button class="${color === 'white' ? 'on' : ''}">Blancs</button></a><a href="#/repertoire/black"><button class="${color === 'black' ? 'on' : ''}">Noirs</button></a></div>
    <span class="muted small" id="sum"></span><div class="spacer"></div>
    <a class="btn btn-sm" href="#/training">S'entraîner →</a></div>`));

  const wrap = h(`<div class="study">
    <div class="board-col">
      <div class="board-row">${evalBarHtml()}<div class="b"></div></div>
      <div class="board-controls">
        <button class="btn icon-btn" data-a="first" title="Début">⏮</button><button class="btn icon-btn" data-a="prev" title="Reculer (←)">◀</button>
        <button class="btn icon-btn" data-a="next" title="Avancer (→)">▶</button><button class="btn icon-btn" data-a="last" title="Fin de la ligne">⏭</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" data-a="add" id="addBtn">Ajouter au répertoire</button>
      </div>
      <div class="panel" style="margin-top:12px"><div class="line" id="line"></div></div>
      <div class="panel"><div class="panel-title"><h2>Lignes du répertoire</h2></div><div class="tree" id="tree"></div></div>
    </div>
    <div class="side">
      <div class="panel" id="here"></div>
      <div class="panel"><div class="panel-title"><h2>Stockfish</h2><div class="spacer"></div><span class="small muted" id="engDepth"></span></div><div id="eng"></div></div>
      <div class="panel"><div class="panel-title"><h2>Explorateur Lichess</h2><div class="spacer"></div><span class="small muted" id="expInfo"></span></div><div id="exp"></div></div>
      <div class="panel"><div class="panel-title"><h2>Dans mes parties</h2></div><div id="mine"></div></div>
    </div></div>`);
  view.append(wrap);

  // ---- État ----
  let line = [];   // [{uci, san}]
  let cur = 0;     // nb de demi-coups affichés
  const board = new Board(wrap.querySelector('.b'), { orientation: color, onMove: (uci, san) => userMove(uci, san) });

  const p = params();
  const init = (p.get('san') || p.get('moves') || '').split(',').filter(Boolean);
  if (init.length) {
    const { moves } = replay(init);
    line = moves.map(m => ({ uci: moveUci(m), san: m.san }));
    cur = line.length;
  }

  function buildGraph(edges) {
    const g = new Map();
    for (const e of edges) {
      if (!g.has(e.fen)) g.set(e.fen, []);
      g.get(e.fen).push(e);
    }
    return g;
  }

  /** Clés des positions le long de la ligne (keys[i] = position avant le coup i). */
  function lineKeys() {
    const c = new Chess();
    const keys = [keyOf(c)];
    for (const m of line) { c.move(m.san); keys.push(keyOf(c)); }
    return keys;
  }

  function userMove(uci, san) {
    if (line[cur] && line[cur].uci === uci) cur++;
    else { line = line.slice(0, cur); line.push({ uci, san }); cur++; }
    refresh();
  }

  function go(n) {
    cur = Math.max(0, Math.min(line.length, n));
    board.setMoves(line.slice(0, cur).map(m => m.uci));
    refresh(false);
  }

  function goLast() {
    // Avance jusqu'au bout de la ligne, puis suit le répertoire tant qu'il n'y a qu'une suite
    if (cur < line.length) return go(line.length);
    const keys = lineKeys();
    let k = keys[cur];
    const c = new Chess();
    line.slice(0, cur).forEach(m => c.move(m.san));
    let guard = 0;
    while (graph.has(k) && graph.get(k).length === 1 && guard++ < 60) {
      const e = graph.get(k)[0];
      c.move(e.san);
      line = line.slice(0, cur); line.push({ uci: e.uci, san: e.san }); cur++;
      k = keyOf(c);
    }
    go(cur);
  }

  let reqId = 0;
  function refresh(sync = true) {
    if (sync) board.setMoves(line.slice(0, cur).map(m => m.uci));
    const keys = lineKeys();
    const key = keys[cur];
    const inRep = line.map((m, i) => (graph.get(keys[i]) || []).some(e => e.uci === m.uci));
    const repHere = graph.get(key) || [];
    const myTurn = board.turn() === color;

    // Ligne courante
    const lineEl = wrap.querySelector('#line');
    lineEl.innerHTML = line.length ? '' : '<span class="muted" style="cursor:default">Position initiale — joue des coups sur l’échiquier.</span>';
    line.forEach((m, i) => {
      if (i % 2 === 0) lineEl.append(h(`<span class="num">${i / 2 + 1}.</span>`));
      const s = h(`<span class="mv ${inRep[i] ? 'inrep' : ''} ${i + 1 === cur ? 'cur' : ''}" title="${inRep[i] ? 'Dans le répertoire' : 'Pas encore dans le répertoire'}">${esc(m.san)}${inRep[i] ? '' : '<sup class="star">+</sup>'}</span>`);
      s.onclick = () => go(i + 1);
      lineEl.append(s);
    });
    const missing = inRep.slice(0, cur).some(x => !x);
    const addBtn = wrap.querySelector('#addBtn');
    addBtn.disabled = !missing;
    addBtn.textContent = missing ? 'Ajouter au répertoire' : (cur ? '✓ Dans le répertoire' : 'Ajouter au répertoire');

    // Flèches : coups du répertoire
    board.shapes(repHere.map(e => arrow(e.uci, myTurn ? 'yellow' : 'blue')));

    renderHere(repHere, myTurn, inRep, key);
    renderTree(keys);
    view.querySelector('#sum').textContent = `${rep.summary.lines} lignes · ${rep.summary.my_positions} positions à connaître`;

    const id = ++reqId;
    const fen = board.fen();
    const whiteToMove = board.turn() === 'white';
    loadEngine(fen, id, whiteToMove, repHere, myTurn);
  }

  // ---- Panneau « Ici » ----
  let explorerData = null, engineData = null;
  function renderHere(repHere, myTurn, inRep, key) {
    const el = wrap.querySelector('#here');
    const reachable = cur === 0 || inRep.slice(0, cur).every(Boolean);
    let html = `<div class="panel-title"><h2>${myTurn ? 'À toi de jouer' : 'Coup adverse'}</h2></div>`;
    if (!reachable) {
      html += `<div class="notice">Cette position n'est pas encore dans ton répertoire. Clique sur <b>Ajouter au répertoire</b> pour enregistrer la ligne jusqu'ici.</div>`;
    } else if (myTurn) {
      html += repHere.length
        ? `<div>Ton coup prévu : ${repHere.map(e => `<span class="chip"><b class="star">${esc(e.san)}</b><button class="btn btn-ghost btn-sm" data-del="${e.uci}" title="Retirer ce coup (et la suite)">✕</button></span>`).join(' ')}</div>`
        : `<div class="notice">Pas encore de coup prévu ici. Choisis-le en t'aidant de Stockfish et de l'explorateur, puis ajoute-le.</div>`;
    } else {
      html += repHere.length
        ? `<div class="small muted" style="margin-bottom:6px">Réponses adverses préparées :</div><div class="played">${repHere.map(e => `<span class="chip"><b>${esc(e.san)}</b><button class="btn btn-ghost btn-sm" data-del="${e.uci}" title="Retirer ce coup (et la suite)">✕</button></span>`).join('')}</div>`
        : `<div class="notice">Aucune réponse adverse préparée. Regarde dans l'explorateur ce que jouent les adversaires de ton niveau et prépare les coups les plus fréquents.</div>`;
      html += `<div id="coverage" class="small" style="margin-top:8px"></div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const e = repHere.find(x => x.uci === b.dataset.del);
      if (!confirm(`Retirer ${e.san} et toute la suite de ce coup du répertoire ?`)) return;
      await api(`/api/repertoire/${color}/delete`, { body: { fen: key, uci: e.uci } });
      await reload();
    });
    if (!myTurn) renderCoverage(repHere);
  }

  function renderCoverage(repHere) {
    const el = wrap.querySelector('#coverage');
    if (!el || !explorerData || !explorerData.moves) return;
    const prepared = new Set(repHere.map(e => e.uci));
    const cov = explorerData.moves.filter(m => prepared.has(m.uci)).reduce((s, m) => s + m.freq, 0);
    const todo = explorerData.moves.filter(m => !prepared.has(m.uci) && m.freq >= 5);
    el.innerHTML = `Couverture : <b class="${cov >= 80 ? 'tag-cov' : 'tag-todo'}">${cov.toFixed(0)} %</b> des parties à ce niveau.` +
      (todo.length ? ` À préparer : ${todo.map(m => `<b>${esc(m.san)}</b> (${m.freq.toFixed(0)} %)`).join(', ')}.` : '');
  }

  // ---- Moteur ----
  let ctx = null; // contexte de la position affichée (pour l'explorateur)
  const engine = enginePanel(wrap.querySelector('#eng'), wrap.querySelector('#engDepth'), board,
    uci => { const m = board.play(uci); if (m) userMove(uci, m.san); },
    d => { engineData = d; if (explorerData && ctx) renderExplorer(ctx.whiteToMove, ctx.repHere, ctx.myTurn); },
    wrap.querySelector('.evalbar'));
  wrap.querySelector('.evalbar').classList.toggle('flip', color === 'black');

  function loadEngine(fen, id, whiteToMove, repHere, myTurn) {
    const exp = wrap.querySelector('#exp');
    engineData = null; explorerData = null;
    ctx = { whiteToMove, repHere, myTurn };
    const f = encodeURIComponent(fen);
    api(`/api/explorer?fen=${f}`).then(d => { if (id !== reqId) return; explorerData = d; renderExplorer(whiteToMove, repHere, myTurn); if (!myTurn) renderCoverage(repHere); })
      .catch(e => { if (id === reqId) exp.innerHTML = `<div class="muted small">${esc(e.message)}</div>`; });
    api(`/api/mytree?fen=${f}&color=${color}`).then(d => { if (id === reqId) renderMine(d); })
      .catch(() => { });
    engine.load(fen);
  }

  function renderExplorer(whiteToMove, repHere, myTurn) {
    const exp = wrap.querySelector('#exp');
    const d = explorerData;
    const info = wrap.querySelector('#expInfo');
    if (d.error) {
      info.textContent = '';
      const msg = {
        no_token: `L'explorateur Lichess demande un jeton d'accès gratuit. Ajoute-le dans <a href="#/settings" class="star">Réglages</a>.`,
        bad_token: `Le jeton Lichess est refusé. Vérifie-le dans <a href="#/settings" class="star">Réglages</a>.`,
        rate_limit: `Trop de requêtes vers Lichess, réessaie dans une minute.`,
      }[d.error] || `Explorateur indisponible (${esc(d.error)}).`;
      exp.innerHTML = `<div class="notice warn">${msg}</div>`;
      return;
    }
    info.textContent = `${d.total.toLocaleString('fr-FR')} parties${d.opening ? ' · ' + d.opening : ''}`;
    if (!d.moves.length) { exp.innerHTML = '<div class="muted small">Aucune partie à ce niveau dans cette position.</div>'; return; }
    const engMap = new Map((engineData?.lines || []).map(l => [l.uci, l]));
    const bestWp = engineData?.lines?.[0]?.wp;
    const prepared = new Set(repHere.map(e => e.uci));
    const t = h(`<table class="t"><thead><tr><th>Coup</th><th class="num">Fréq.</th><th>Blancs / nulle / Noirs</th><th class="num">Éval</th><th></th></tr></thead><tbody></tbody></table>`);
    const tb = t.querySelector('tbody');
    for (const m of d.moves.slice(0, 10)) {
      const e = engMap.get(m.uci);
      let tag = '';
      if (prepared.has(m.uci)) tag = `<span class="badge good">répertoire</span>`;
      else if (e && bestWp != null && bestWp - e.wp <= 3) tag = `<span class="badge accent" title="Parmi les meilleurs coups selon Stockfish">★ top</span>`;
      else if (e && bestWp != null && bestWp - e.wp > 10) tag = `<span class="badge mistake" title="Stockfish le trouve nettement moins bon">${myTurn ? 'douteux' : 'imprécis'}</span>`;
      else if (!e && engineData) tag = `<span class="badge" title="Pas dans les ${engineData.lines.length} meilleurs coups de Stockfish">hors top ${engineData.lines.length}</span>`;
      if (!myTurn && !prepared.has(m.uci) && m.freq >= 5) tag += ` <span class="badge info">à préparer</span>`;
      const tr = h(`<tr class="click"><td class="mvcell">${esc(m.san)}</td><td class="num">${m.freq.toFixed(0)} %<div class="small muted">${m.games.toLocaleString('fr-FR')}</div></td>
        <td><div class="wdl"><div class="w" style="width:${m.white}%">${m.white >= 15 ? m.white.toFixed(0) : ''}</div><div class="d" style="width:${m.draws}%">${m.draws >= 15 ? m.draws.toFixed(0) : ''}</div><div class="b" style="width:${m.black}%">${m.black >= 15 ? m.black.toFixed(0) : ''}</div></div></td>
        <td class="num mono small">${e ? fmtEval(e.cp, e.mate, whiteToMove) : ''}</td><td>${tag}</td></tr>`);
      hoverArrow(tr, m.uci);
      tr.onclick = () => { const mv = board.play(m.uci); if (mv) userMove(m.uci, mv.san); };
      tb.append(tr);
    }
    exp.innerHTML = '';
    exp.append(t);
    exp.append(h(`<div class="small muted" style="margin-top:6px">Score du point de vue de chaque camp ; ★ = coup parmi les meilleurs pour Stockfish et réellement joué à ton niveau.</div>`));
  }

  /** Survol d'une ligne de tableau : seule la flèche de ce coup est affichée. */
  function hoverArrow(tr, uci) {
    tr.onmouseenter = () => board.hover([arrow(uci, 'engine')]);
    tr.onmouseleave = () => board.hover(null);
  }

  function renderMine(d) {
    const el = wrap.querySelector('#mine');
    if (!d.length) { el.innerHTML = '<div class="muted small">Tu n’as jamais eu cette position.</div>'; return; }
    const t = h(`<table class="t"><thead><tr><th>Coup</th><th class="num">Parties</th><th class="num">Ton score</th><th></th></tr></thead><tbody></tbody></table>`);
    for (const m of d) {
      const tr = h(`<tr class="click"><td class="mvcell">${esc(m.san)} <span class="small muted">${m.mine ? '(toi)' : ''}</span></td><td class="num">${m.n}</td>
        <td class="num">${pct(m.score)}</td><td>${m.cls ? `<span class="badge ${m.cls}">-${m.avg_loss.toFixed(0)} % en moy.</span>` : ''}</td></tr>`);
      hoverArrow(tr, m.uci);
      tr.onclick = () => { const mv = board.play(m.uci); if (mv) userMove(m.uci, mv.san); };
      t.querySelector('tbody').append(tr);
    }
    el.innerHTML = '';
    el.append(t);
  }

  // ---- Arbre ----
  function renderTree(keys) {
    const el = wrap.querySelector('#tree');
    el.innerHTML = '';
    if (!rep.edges.length) { el.innerHTML = '<div class="muted small">Ton répertoire est vide. Joue une ligne sur l’échiquier puis clique sur « Ajouter au répertoire ».</div>'; return; }
    const curPath = line.slice(0, cur).map(m => m.uci).join(' ');
    const start = keyOf(new Chess());
    // Les suites sans embranchement restent sur une ligne ; chaque embranchement ouvre un bloc indenté.
    const walkInto = (fen, ply, path, container, row, seen) => {
      let edges = graph.get(fen) || [];
      while (edges.length === 1) {
        const e = edges[0];
        appendMove(row, e, ply, path, false);
        path = [...path, e.uci];
        if (seen.has(e.fen_after)) return;
        seen = new Set(seen).add(e.fen_after);
        fen = e.fen_after; ply++;
        edges = graph.get(fen) || [];
      }
      for (const e of edges) {
        const node = h(`<div class="node"></div>`);
        container.append(node);
        const r = h(`<div class="row"></div>`);
        node.append(r);
        appendMove(r, e, ply, path, true);
        if (!seen.has(e.fen_after)) walkInto(e.fen_after, ply + 1, [...path, e.uci], node, r, new Set(seen).add(e.fen_after));
      }
    };
    const appendMove = (row, e, ply, path, forceNum) => {
      const full = [...path, e.uci];
      const label = ply % 2 === 0 ? `${ply / 2 + 1}.${e.san}` : (forceNum ? `${(ply + 1) / 2}…${e.san}` : e.san);
      const s = h(`<span class="${full.join(' ') === curPath ? 'cur' : ''}">${esc(label)}</span>`);
      s.onclick = () => {
        const { moves } = replay(full);
        line = moves.map(m => ({ uci: moveUci(m), san: m.san }));
        cur = line.length;
        refresh();
      };
      row.append(s, ' ');
    };
    const root = h(`<div class="row"></div>`);
    el.append(root);
    walkInto(start, 0, [], el, root, new Set([start]));
    scrollWithin(el, el.querySelector('.cur'));
  }

  async function reload() {
    rep = await api(`/api/repertoire/${color}`);
    graph = buildGraph(rep.edges);
    refresh();
  }

  async function addLine(replace = false) {
    const res = await api(`/api/repertoire/${color}/line`, { body: { moves: line.slice(0, cur).map(m => m.uci), replace } });
    if (res.conflict) {
      if (confirm(`Ton répertoire prévoit déjà ${res.existing} dans cette position (coup ${Math.floor(res.ply / 2) + 1}).\nLe remplacer par ${res.new} ? La suite de ${res.existing} sera supprimée.`)) return addLine(true);
      return;
    }
    if (!res.ok) { toast(res.error || 'Erreur'); return; }
    toast('Ligne ajoutée au répertoire');
    await reload();
  }

  wrap.querySelector('.board-controls').onclick = e => {
    const a = e.target.dataset.a;
    if (a === 'first') go(0);
    if (a === 'prev') go(cur - 1);
    if (a === 'next') go(cur + 1);
    if (a === 'last') goLast();
    if (a === 'add') addLine();
  };
  const key = e => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') go(cur - 1);
    if (e.key === 'ArrowRight') {
      if (cur < line.length) go(cur + 1);
      else {
        const k = lineKeys()[cur];
        const es = graph.get(k) || [];
        if (es.length) { const m = board.play(es[0].uci); if (m) userMove(es[0].uci, m.san); }
      }
    }
    if (e.key === 'Home') go(0);
    if (e.key === 'End') goLast();
  };
  window.addEventListener('keydown', key);
  refresh();
  return () => { window.removeEventListener('keydown', key); engine.destroy(); board.destroy(); };
}
