export async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.body && typeof opts.body !== 'string') {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
    init.method = init.method || 'POST';
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { }
    throw new Error(msg);
  }
  return r.json();
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function pct(x, d = 0) { return x == null ? '–' : (100 * x).toFixed(d) + ' %'; }

export function fmtDate(ts) {
  if (!ts) return '–';
  return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
}

export function resultClass(score) { return score === 1 ? 'win' : score === 0.5 ? 'draw' : 'loss'; }
export function resultLabel(score) { return score === 1 ? 'Gain' : score === 0.5 ? 'Nulle' : 'Perte'; }

export const CLS_LABEL = { inaccuracy: 'Imprécision', mistake: 'Erreur', blunder: 'Gaffe' };
export const COLOR_LABEL = { white: 'Blancs', black: 'Noirs' };

/** Éval lisible du point de vue des Blancs. cp/mate sont donnés pour le camp au trait. */
export function fmtEval(cp, mate, whiteToMove) {
  const sign = whiteToMove ? 1 : -1;
  if (mate != null) { const m = mate * sign; return (m > 0 ? '#' : '#-') + Math.abs(m); }
  if (cp == null) return '–';
  const v = (cp * sign) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

/** Affiche une suite de coups SAN numérotée (texte). */
export function lineText(sans, startPly = 0) {
  return sans.map((s, i) => {
    const ply = startPly + i;
    return ply % 2 === 0 ? `${ply / 2 + 1}.${s}` : (i === 0 ? `${(ply + 1) / 2}…${s}` : s);
  }).join(' ');
}

export function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

export function scoreBar(w, d, l) {
  const n = w + d + l || 1;
  return `<div class="scorebar" title="${w} G · ${d} N · ${l} P"><div class="w" style="width:${100 * w / n}%"></div><div class="d" style="width:${100 * d / n}%"></div><div class="l" style="width:${100 * l / n}%"></div></div>`;
}

export function params() {
  const q = location.hash.split('?')[1] || '';
  return new URLSearchParams(q);
}

/** Fait défiler un conteneur pour montrer el, sans faire bouger le reste de la page. */
export function scrollWithin(container, el) {
  if (!el) return;
  const c = container.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (r.top < c.top) container.scrollTop -= c.top - r.top + 8;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom + 8;
}

// ---- Formation : texte enrichi des leçons ----
const FIG = { N: '♞', B: '♝', R: '♜', Q: '♛', K: '♚' };

/** Coup SAN en notation figurine (« ...Qxd1 » -> « …♛xd1 »). */
export function fig(san) {
  const m = String(san).match(/^(\.\.\.)?(.*)$/);
  return (m[1] ? '…' : '') + m[2].replace(/^[NBRQK]/, p => FIG[p]);
}

/** Texte de leçon : **gras**, [coup] en figurine, paragraphes séparés par une ligne vide. */
export function rich(text) {
  return esc(text || '').split(/\n\n/).map(p => '<p>' + p
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]/g, (_, mv) => `<span class="fmv">${fig(mv)}</span>`) + '</p>').join('');
}

const BRUSH = { G: 'green', R: 'red', B: 'blue', Y: 'yellow' };

/** Formes de leçon : « Gg2b7 » (flèche verte g2→b7), « Rd5 » (cercle rouge en d5). */
export function lessonShapes(list) {
  return (list || []).map(s => {
    const brush = BRUSH[s[0]] || 'green';
    return s.length === 5 ? { orig: s.slice(1, 3), dest: s.slice(3, 5), brush } : { orig: s.slice(1, 3), brush };
  });
}
