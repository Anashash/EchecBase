import { Chessground } from '../vendor/chessground.js';
import { Chess } from '../vendor/chess.js';

export { Chess };

const FILES = 'abcdefgh';

/** Clé de position identique à python-chess board.epd() (case de prise en passant seulement si la prise est légale). */
export function keyOf(chess) {
  const parts = chess.fen().split(' ');
  if (parts[3] !== '-') {
    const ep = chess.moves({ verbose: true }).some(m => m.flags.includes('e'));
    if (!ep) parts[3] = '-';
  }
  return parts.slice(0, 4).join(' ');
}

export function fullFen(key) { return key.split(' ').length >= 6 ? key : key + ' 0 1'; }

export function dests(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

export function moveUci(m) { return m.from + m.to + (m.promotion || ''); }

/** Rejoue une liste de coups (UCI ou SAN) depuis la position initiale. */
export function replay(moves) {
  const chess = new Chess();
  const out = [];
  for (const mv of moves) {
    let m;
    try { m = chess.move(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(mv) ? uciToMove(mv) : mv); }
    catch { break; }
    out.push(m);
  }
  return { chess, moves: out };
}

export function arrow(uci, brush = 'green') {
  return { orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush };
}

const BRUSHES = {
  green: { key: 'g', color: '#5fae7c', opacity: 0.85, lineWidth: 10 },
  red: { key: 'r', color: '#df5656', opacity: 0.85, lineWidth: 10 },
  blue: { key: 'b', color: '#6f9fd8', opacity: 0.8, lineWidth: 10 },
  yellow: { key: 'y', color: '#c8a96a', opacity: 0.85, lineWidth: 10 },
  paleGrey: { key: 'pgr', color: '#9a9aa2', opacity: 0.45, lineWidth: 12 },
  teal: { key: 't', color: '#26c2a3', opacity: 0.9, lineWidth: 10 },
  engine: { key: 'e', color: '#5fae7c', opacity: 0.9, lineWidth: 11 },
  engineAlt: { key: 'ea', color: '#5fae7c', opacity: 0.5, lineWidth: 8 },
};

/** Échiquier interactif. onMove(uci, san, move) est appelé après chaque coup légal joué à la main. */
export class Board {
  constructor(el, { orientation = 'white', interactive = true, onMove = null, onSquare = null, coordinates = true } = {}) {
    this.chess = new Chess();
    this.onMove = onMove;
    this.el = el;
    this.orientation = orientation;
    // Clic sur une case (quiz « clique sur la case ») : actif seulement si onSquare est défini
    this.onSquare = onSquare;
    el.addEventListener('click', (e) => {
      if (!this.onSquare) return;
      const sq = this.squareAt(e.clientX, e.clientY);
      if (sq) this.onSquare(sq);
    });
    this.interactive = interactive;
    // Flèches par calques : « base » (répertoire, erreurs…) et « engine » (coups Stockfish).
    // Un survol remplace temporairement tout l'affichage.
    this._layers = { base: [], engine: [] };
    this._hover = null;
    this.cg = Chessground(el, {
      orientation,
      coordinates,
      animation: { duration: 160 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, color: interactive ? 'white' : undefined, showDests: true, events: { after: (o, d) => this._userMove(o, d) } },
      draggable: { showGhost: true },
      premovable: { enabled: false },
      drawable: { enabled: true, brushes: BRUSHES, defaultSnapToValidMove: true },
    });
    this._sync();
  }

  _userMove(from, to) {
    let m;
    try {
      const piece = this.chess.get(from);
      const promo = piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined;
      m = this.chess.move({ from, to, promotion: promo });
    } catch { this._sync(); return; }
    this._sync([from, to]);
    this.onMove && this.onMove(moveUci(m), m.san, m);
  }

  _sync(lastMove) {
    const turn = this.chess.turn() === 'w' ? 'white' : 'black';
    const allowed = this.interactive === true ? turn : this.interactive === turn ? turn : undefined;
    this.cg.set({
      fen: this.chess.fen(),
      turnColor: turn,
      check: this.chess.inCheck(),
      lastMove: lastMove || this._lastMove,
      movable: { color: allowed, dests: allowed ? dests(this.chess) : new Map() },
    });
    if (lastMove) this._lastMove = lastMove;
  }

  /** Positionne l'échiquier après une suite de coups. */
  setMoves(moves) {
    const { chess, moves: played } = replay(moves);
    this.chess = chess;
    const last = played[played.length - 1];
    this._lastMove = last ? [last.from, last.to] : undefined;
    this.cg.set({ lastMove: this._lastMove });
    this._sync();
    return played;
  }

  setFen(fen, lastUci) {
    this.chess = new Chess(fullFen(fen));
    this._lastMove = lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : undefined;
    this.cg.set({ lastMove: this._lastMove });
    this._sync();
  }

  /** Joue un coup par programme (avec animation). */
  play(uciOrSan) {
    let m;
    try { m = this.chess.move(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uciOrSan) ? uciToMove(uciOrSan) : uciOrSan); }
    catch { return null; }
    this.cg.move(m.from, m.to);
    this._sync([m.from, m.to]);
    return m;
  }

  setInteractive(v) { this.interactive = v; this._sync(); }
  setOrientation(o) { this.orientation = o; this.cg.set({ orientation: o }); }
  flip() { this.orientation = this.orientation === 'white' ? 'black' : 'white'; this.cg.toggleOrientation(); }
  /** Case sous un point de l'écran (null hors de l'échiquier). */
  squareAt(x, y) {
    const r = this.el.getBoundingClientRect();
    const fx = Math.floor((x - r.left) / (r.width / 8)), fy = Math.floor((y - r.top) / (r.height / 8));
    if (fx < 0 || fx > 7 || fy < 0 || fy > 7) return null;
    return this.orientation === 'white' ? FILES[fx] + (8 - fy) : FILES[7 - fx] + (fy + 1);
  }
  shapes(list) { this.layer('base', list); }
  layer(name, list) { this._layers[name] = list || []; this._drawShapes(); }
  hover(list) { this._hover = list; this._drawShapes(); }
  _drawShapes() { this.cg.setAutoShapes(this._hover || [...this._layers.base, ...this._layers.engine]); }
  key() { return keyOf(this.chess); }
  fen() { return this.chess.fen(); }
  turn() { return this.chess.turn() === 'w' ? 'white' : 'black'; }
  destroy() { this.cg.destroy(); }
}

/** Petit échiquier statique. */
export function miniBoard(el, fen, orientation = 'white', shapes = [], lastUci = null, tries = 0) {
  // Chessground mesure l'élément : on attend qu'il soit dans la page (abandon si la page a changé).
  if (!el.isConnected) {
    if (tries < 50) setTimeout(() => miniBoard(el, fen, orientation, shapes, lastUci, tries + 1), 20);
    return;
  }
  const cg = Chessground(el, {
    fen: fullFen(fen).split(' ')[0],
    orientation,
    viewOnly: true,
    coordinates: false,
    lastMove: lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : undefined,
    drawable: { enabled: false, visible: true, brushes: BRUSHES, autoShapes: shapes },
  });
  return cg;
}

window.addEventListener('resize', () => document.body.dispatchEvent(new Event('chessground.resize')));
export { FILES };
