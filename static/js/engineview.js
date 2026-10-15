import { api, h, esc, fmtEval } from './util.js';
import { arrow, Chess, fullFen } from './board.js';

// Coups « jouables » : à moins de 5 points de % de gain du meilleur, 3 au maximum.
const CLOSE_WP = 5;
const MAX_ARROWS = 3;

/**
 * Panneau Stockfish lié à un échiquier : lignes principales, flèches des meilleurs coups,
 * survol d'une ligne = seule sa flèche est affichée.
 * Renvoie { load(fen), clear(), destroy(), lines(fen) }. onPick(uci) est appelé au clic sur une ligne, onData(d) à chaque résultat.
 */
export function enginePanel(container, depthEl, board, onPick, onData, evalEl = null) {
  let reqId = 0;
  let timer = null;
  // position -> { p: promesse des lignes, ctl: AbortController, pinned } : une seule analyse par position.
  // pinned = demandée par lines() (autre que l'affichage) : on ne l'abandonne pas en changeant de position.
  const cache = new Map();
  let shown = null; // analyse en cours pour l'affichage

  function request(fen, pinned) {
    const k = fen.split(' ').slice(0, 4).join(' ');
    let e = cache.get(k);
    if (!e) {
      const ctl = new AbortController();
      e = { ctl, pinned: false, p: api(`/api/engine?fen=${encodeURIComponent(fen)}`, { signal: ctl.signal }) };
      e.p.catch(() => { if (cache.get(k) === e) cache.delete(k); });
      cache.set(k, e);
    }
    if (pinned) e.pinned = true;
    return e;
  }

  /** Lignes Stockfish d'une position (partagées entre l'affichage et les autres demandes). */
  function lines(fen) { return request(fen, true).p; }

  function clear() {
    reqId++;
    clearTimeout(timer);
    // Analyse d'une position qu'on vient de quitter : abandonnée, sinon les requêtes s'empilent
    // (et le navigateur, limité à 6 connexions, bloque tout le reste de l'appli derrière elles).
    if (shown && !shown.pinned) shown.ctl.abort();
    shown = null;
    board.hover(null);
    board.layer('engine', []);
  }

  /** À la fermeture de la page : abandonne toutes les analyses en attente. */
  function destroy() {
    clear();
    cache.forEach(e => e.ctl.abort());
    cache.clear();
  }

  function load(fen, delay = 0) {
    clear();
    const id = reqId;
    container.innerHTML = '<div class="muted small"><span class="spin"></span> Analyse…</div>';
    timer = setTimeout(async () => {
      try {
        shown = request(fen, false);
        const d = await shown.p;
        if (id !== reqId) return;
        render(d, fen);
        onData && onData(d);
      } catch (e) {
        if (id === reqId) container.innerHTML = `<div class="muted small">Erreur moteur : ${esc(e.message)}</div>`;
      }
    }, delay);
    return id;
  }

  function render(d, fen) {
    const whiteToMove = fen.split(' ')[1] === 'w';
    if (depthEl) depthEl.textContent = d.depth ? `profondeur ${d.depth}` : '';
    container.innerHTML = '';
    if (!d.lines.length) {
      // Plus aucun coup : mat ou pat. La barre donne le résultat (et non plus l'éval de la position d'avant).
      const mate = new Chess(fullFen(fen)).isCheckmate();
      const winner = whiteToMove ? 'Noirs' : 'Blancs';
      container.innerHTML = `<div class="muted small">${mate ? `Échec et mat : les ${winner} gagnent.` : 'Pat : partie nulle.'}</div>`;
      if (evalEl) setEvalBar(evalEl, mate ? (whiteToMove ? 0 : 100) : 50, mate ? (whiteToMove ? '0-1' : '1-0') : '½-½');
      return;
    }
    const best = d.lines[0].wp;
    if (evalEl) {
      const l = d.lines[0];
      setEvalBar(evalEl, whiteToMove ? best : 100 - best, fmtEval(l.cp, l.mate, whiteToMove));
    }
    const good = d.lines.filter(l => best - l.wp <= CLOSE_WP).slice(0, MAX_ARROWS);
    board.layer('engine', good.map((l, i) => arrow(l.uci, i === 0 ? 'engine' : 'engineAlt')));
    for (const l of d.lines) {
      const drop = best - l.wp;
      const row = h(`<div class="eng-line"><span class="ev">${fmtEval(l.cp, l.mate, whiteToMove)}</span>
        <span class="pv"><b>${esc(l.pv[0])}</b> ${esc(l.pv.slice(1).join(' '))}</span>
        ${drop > 8 ? `<span class="badge mistake" style="margin-left:auto">-${drop.toFixed(0)} %</span>` : ''}</div>`);
      row.onmouseenter = () => board.hover([arrow(l.uci, 'engine')]);
      row.onmouseleave = () => board.hover(null);
      row.onclick = () => { board.hover(null); onPick && onPick(l.uci); };
      container.append(row);
    }
    container.onmouseleave = () => board.hover(null);
  }

  return { load, clear, destroy, lines };
}

/** Barre d'évaluation : wpWhite = % de gain des Blancs (0-100), label = score lisible. */
export function setEvalBar(el, wpWhite, label) {
  el.querySelector('.fill').style.height = `${Math.max(2, Math.min(98, wpWhite))}%`;
  const t = el.querySelector('.txt');
  t.textContent = label.replace(/^\+/, '');
  // Le texte se place du côté du camp avantagé, sur sa couleur
  t.classList.toggle('on-white', wpWhite >= 50);
}

export function evalBarHtml() {
  return '<div class="evalbar" title="Évaluation Stockfish"><div class="fill"></div><span class="txt">0.00</span></div>';
}
