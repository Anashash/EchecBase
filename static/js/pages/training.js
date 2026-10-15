import { api, h, esc, lineText, rich, fig, COLOR_LABEL } from '../util.js';
import { Board, arrow } from '../board.js';

let deck = 'all';

export async function render(view) {
  // La Formation est un module optionnel : sans lui, pas de paquet « Formation »
  const formation = !!document.querySelector('#nav a[data-route="formation"]');
  if (!formation && deck === 'course') deck = 'all';
  view.append(h(`<div class="page-head"><h1>Entraînement</h1>
    <div class="seg" id="deck"><button data-v="all">Tout</button><button data-v="rep">Mon répertoire</button><button data-v="fix">Mes erreurs</button>${formation ? '<button data-v="course">Formation</button>' : ''}</div>
    <div class="spacer"></div><span class="small muted" id="cnt"></span></div>`));
  const wrap = h(`<div class="study">
    <div class="board-col"><div class="b"></div></div>
    <div class="side">
      <div class="panel" id="card"></div>
      <div id="fb"></div>
      <div class="panel small muted" id="help">
        <b style="color:var(--text-2)">Comment ça marche</b><br>
        <b>Mon répertoire</b> : retrouve le coup que tu as prévu dans chaque position de ton répertoire.<br>
        <b>Mes erreurs</b> : positions de tes parties où tu as fait une erreur ; trouve un bon coup.<br>
        ${formation ? '<b>Formation</b> : les quiz des leçons que tu as terminées.<br>' : ''}
        Bonne réponse → la carte revient dans 1 jour, puis 3, puis de plus en plus tard. Erreur → elle revient dans 10 minutes.
      </div>
    </div></div>`);
  view.append(wrap);

  const board = new Board(wrap.querySelector('.b'), { interactive: false, onMove: (uci) => answer(uci) });
  let card = null;
  let busy = false;

  const counts = c => {
    const lab = { all: 'Tout', rep: 'Mon répertoire', fix: 'Mes erreurs', course: 'Formation' };
    view.querySelectorAll('#deck button').forEach(b => {
      const x = c[b.dataset.v];
      b.classList.toggle('on', b.dataset.v === deck);
      b.innerHTML = `${lab[b.dataset.v]}<span class="count">${x.due}</span>`;
    });
    view.querySelector('#cnt').textContent = `${c[deck].due} à revoir · ${c[deck].total} cartes`;
  };

  async function next(exclude = '') {
    wrap.querySelector('#fb').innerHTML = '';
    const r = await api(`/api/training/next?kind=${deck}&exclude=${encodeURIComponent(exclude)}`);
    counts(r.counts);
    card = r.card;
    const cEl = wrap.querySelector('#card');
    board.shapes([]);
    board.onSquare = null;
    if (!card) {
      board.setMoves([]);
      board.setInteractive(false);
      cEl.innerHTML = r.counts[deck].total
        ? `<h3>Tout est à jour</h3><p class="muted">Aucune carte à revoir pour l'instant. Reviens plus tard !</p>`
        : `<h3>Aucune carte</h3><p class="muted">${deck === 'fix' ? 'Les cartes « erreurs » sont créées après l’analyse de tes parties.'
          : deck === 'course' ? 'Termine une leçon de la <a class="star" href="#/formation">Formation</a> : ses quiz arrivent ici.'
          : 'Ajoute des lignes à ton <a class="star" href="#/repertoire/white">répertoire</a> pour créer des cartes.'}</p>`;
      return;
    }
    board.setOrientation(card.color);
    // Montre la position précédente puis anime le dernier coup adverse
    const ucis = card.line;
    board.setMoves(ucis.slice(0, -1));
    board.setInteractive(false);
    const quiz = card.kind === 'course' ? card.quiz : null;
    setTimeout(() => {
      if (ucis.length) board.play(ucis[ucis.length - 1]);
      if (!quiz || quiz.type === 'move') board.setInteractive(card.color);
      if (quiz && quiz.type === 'square') board.onSquare = sq => answer(`square:${sq}`);
    }, ucis.length ? 350 : 0);
    const isNew = card.last == null;
    if (quiz) {
      cEl.innerHTML = `<div class="panel-title"><span class="dot ${card.color}"></span><h2>${COLOR_LABEL[card.color]} · Formation</h2><div class="spacer"></div>${isNew ? '<span class="badge accent">nouvelle</span>' : `<span class="badge">série ${card.reps}</span>`}</div>
        <div class="small muted" style="margin-bottom:8px">${esc(quiz.title)} · ${esc(lineText(card.sans.map(fig))) || 'Position initiale'}</div>
        <div class="q-text">${rich(quiz.q)}</div>
        ${quiz.type === 'choice' ? `<div class="choices">${quiz.options.map((t, i) => `<button class="choice" data-i="${i}">${rich(t)}</button>`).join('')}</div>` : ''}
        ${quiz.type === 'square' ? '<div class="small muted" style="margin-top:6px">Clique sur une case de l’échiquier.</div>' : ''}`;
      cEl.querySelectorAll('.choice').forEach(b => { b.onclick = () => answer(`choice:${b.dataset.i}`); });
      return;
    }
    cEl.innerHTML = `<div class="panel-title"><span class="dot ${card.color}"></span><h2>${COLOR_LABEL[card.color]} · ${card.kind === 'rep' ? 'Répertoire' : 'Erreur à corriger'}</h2><div class="spacer"></div>${isNew ? '<span class="badge accent">nouvelle</span>' : `<span class="badge">série ${card.reps}</span>`}</div>
      <div class="small muted" style="margin-bottom:8px">${esc(lineText(card.sans)) || 'Position initiale'}</div>
      <div style="font-size:16px">${card.kind === 'rep' ? 'Quel est ton coup ?' : 'Trouve un bon coup.'}</div>
      ${card.kind === 'fix' && card.n ? `<div class="small muted" style="margin-top:4px">Position rencontrée ${card.n} fois dans tes parties.</div>` : ''}`;
  }

  async function answer(uci) {
    if (!card || busy) return;
    busy = true;
    board.setInteractive(false);
    const fb = wrap.querySelector('#fb');
    fb.innerHTML = `<div class="feedback"><span class="spin"></span> Vérification…</div>`;
    try {
      const r = await api('/api/training/answer', { body: { id: card.id, uci } });
      if (r.error) { fb.innerHTML = `<div class="feedback ko">${esc(r.error)}</div>`; return; }
      if (card.kind === 'course') { courseFeedback(r, uci); return; }
      const shapes = r.correct ? [] : [arrow(uci, 'red')];
      r.expected_uci.forEach(u => shapes.push(arrow(u, 'green')));
      if (!r.correct) {
        // Revient à la position pour montrer la bonne réponse
        board.setMoves(card.line);
      }
      board.shapes(shapes);
      fb.innerHTML = `<div class="feedback ${r.correct ? 'ok' : 'ko'}">
        <div class="big">${r.correct ? 'Correct' : 'Pas tout à fait'}</div>
        <div>Tu as joué <b>${esc(r.played)}</b>. ${r.correct && r.expected.includes(r.played) ? '' : `Réponse attendue : <b class="star">${esc(r.expected.join(' / '))}</b>.`}</div>
        ${r.note ? `<div class="small muted" style="margin-top:4px">${esc(r.note)}</div>` : ''}
        ${card.kind === 'fix' && card.bad ? `<div class="small muted" style="margin-top:4px">Dans tes parties, tu avais joué <b>${esc(card.bad)}</b> ici.</div>` : ''}
        <div style="margin-top:12px;display:flex;gap:8px"><button class="btn btn-primary" id="nx">Suivant (Entrée)</button>
        <a class="btn btn-ghost" href="#/repertoire/${card.color}?moves=${encodeURIComponent(card.line.join(','))}">Ouvrir dans le répertoire</a></div></div>`;
      fb.querySelector('#nx').onclick = () => next(card.id);
    } finally { busy = false; }
  }

  function courseFeedback(r, value) {
    const quiz = card.quiz;
    const fb = wrap.querySelector('#fb');
    board.onSquare = null;
    let shapes = [];
    if (quiz.type === 'move') {
      if (!r.correct) { board.setMoves(card.line); shapes.push(arrow(value, 'red')); }
      r.expected_uci.forEach(u => shapes.push(arrow(u, 'green')));
    } else if (quiz.type === 'square') {
      shapes = r.expected.map(s => ({ orig: s, brush: 'green' }));
      if (!r.correct) shapes.push({ orig: r.clicked, brush: 'red' });
    } else {
      wrap.querySelectorAll('.choice').forEach((b, i) => {
        b.disabled = true;
        if (i === r.good) b.classList.add('good');
        if (i === r.chosen && !r.correct) b.classList.add('bad');
      });
    }
    board.shapes(shapes);
    fb.innerHTML = `<div class="feedback ${r.correct ? 'ok' : 'ko'}">
      <div class="big">${r.correct ? 'Correct' : 'Pas tout à fait'}</div>
      ${quiz.type === 'move' ? `<div>Tu as joué <span class="fmv">${esc(fig(r.played))}</span>.${r.correct ? '' : ` Réponse : ${r.expected.map(s => `<span class="fmv">${esc(fig(s))}</span>`).join(' / ')}.`}</div>` : ''}
      ${r.note ? `<div class="small" style="margin-top:4px">${rich(r.note)}</div>` : ''}
      <div class="say-text small">${rich(r.explain)}</div>
      <div style="margin-top:12px;display:flex;gap:8px"><button class="btn btn-primary" id="nx">Suivant (Entrée)</button>
      <a class="btn btn-ghost" href="#/formation/${quiz.course}/${quiz.lesson}">Revoir la leçon</a></div></div>`;
    fb.querySelector('#nx').onclick = () => next(card.id);
  }

  const key = e => { if (e.key === 'Enter' && wrap.querySelector('#nx')) next(card?.id || ''); };
  window.addEventListener('keydown', key);
  view.querySelector('#deck').onclick = e => { const b = e.target.closest('button'); if (b) { deck = b.dataset.v; next(); } };
  await api('/api/training/sync', { method: 'POST' });
  await next();
  return () => { window.removeEventListener('keydown', key); board.destroy(); };
}
