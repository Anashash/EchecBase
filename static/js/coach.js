import { T } from './coach-lines.js';

// Le coach robot. Il suit la partie dans l'ordre et garde en tête ce qui s'est passé :
// séries de bons coups, gaffes déjà commises (et pardonnées), tendance de l'éval, pendules, motif de fin.
// Plutôt calme sur les coups ordinaires, ravi quand ça s'enchaîne, odieux sur les gaffes.
// Les positions déjà jouées (gagnées ou perdues d'avance) ne comptent ni pour les séries ni pour la tension.

export const RC = {
  brilliant: { label: 'Brillant', sym: '!!', color: '#26c2a3' },
  great: { label: 'Très bon coup', sym: '!', color: '#5c8bb0' },
  best: { label: 'Meilleur coup', sym: '★', color: '#81b64c' },
  excellent: { label: 'Excellent', sym: '✓', color: '#96bc4b' },
  good: { label: 'Bon', sym: '✓', color: '#8a9a7b' },
  book: { label: 'Théorie', sym: '≡', color: '#a88865' },
  inaccuracy: { label: 'Imprécision', sym: '?!', color: '#f0c13a' },
  mistake: { label: 'Erreur', sym: '?', color: '#ffa459' },
  miss: { label: 'Occasion ratée', sym: '✕', color: '#ff7769' },
  blunder: { label: 'Gaffe', sym: '??', color: '#fa412d' },
};
export const RC_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

export function rcIcon(rc, size = '') {
  const c = RC[rc];
  return c ? `<span class="rc ${size}" style="background:${c.color}" title="${c.label}">${c.sym}</span>` : '';
}

/** 3,2 s · 42 s · 1 min 05 */
export function fmtSpent(s) {
  if (s == null) return '';
  if (s < 10) return `${s.toFixed(1).replace('.', ',')} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? `${m} min ${String(r).padStart(2, '0')}` : `${m} min`;
}

/** Affichage pendule : 4:59 · 0:08.4 */
export function fmtClock(s) {
  if (s == null) return '–';
  const m = Math.floor(s / 60), r = s - m * 60;
  return s < 20 ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Mécanique

function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tire les répliques sans répétition (chaque réserve est mélangée puis parcourue). */
function picker(rand) {
  const decks = {}, last = {};
  return name => {
    const pool = T[name] || T.fallback;
    let d = decks[name];
    if (!d || !d.length) {
      d = decks[name] = pool.map((_, i) => i);
      for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
      // Pas deux fois la même réplique à la jonction de deux paquets
      if (d.length > 1 && d[d.length - 1] === last[name]) [d[0], d[d.length - 1]] = [d[d.length - 1], d[0]];
    }
    last[name] = d.pop();
    return pool[last[name]];
  };
}

function fill(s, v) {
  return s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
}

/** Accords : ton/ta, le/la, un/une, gratuit/gratuite… selon la pièce. */
function agree(v) {
  const f = ['dame', 'tour'].includes(v.piece);
  Object.assign(v, {
    il: f ? 'elle' : 'il', Il: f ? 'Elle' : 'Il', ton: f ? 'ta' : 'ton', Ton: f ? 'Ta' : 'Ton', TON: f ? 'TA' : 'TON',
    son: f ? 'sa' : 'son', Son: f ? 'Sa' : 'Son', le: f ? 'la' : 'le', Le: f ? 'La' : 'Le',
    un: f ? 'une' : 'un', Un: f ? 'Une' : 'Un', e: f ? 'e' : '', E: f ? 'E' : '', lequel: f ? 'laquelle' : 'lequel',
    PIECE: (v.piece || '').toUpperCase(),
  });
}

/** Éval approximative (en pions, de mon point de vue) à partir d'un % de gain : « +2,4 ». */
function evalLabel(wp) {
  const w = Math.min(99, Math.max(1, wp ?? 50));
  const x = (w - 50) / 50;
  const p = -Math.log(2 / (x + 1) - 1) / 0.368208;
  return (p >= 0 ? '+' : '−') + Math.abs(p).toFixed(1).replace('.', ',');
}

const VAL = { q: 9, r: 5, b: 3, n: 3, p: 1 };
/** Matériel lu dans la clé FEN : dames restantes, matériel hors pions (les deux camps). */
function material(fen) {
  let q = 0, pieces = 0;
  for (const c of (fen || '').split(' ')[0]) {
    const l = c.toLowerCase();
    if (l === 'q') q++;
    if (VAL[l] && l !== 'p') pieces += VAL[l];
  }
  return { q, pieces };
}

const GOOD = new Set(['best', 'excellent', 'great', 'brilliant']);
const ERR = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);
const BAD = new Set(['mistake', 'miss', 'blunder']);
// Répliques banales : remplacées par la conclusion sur le dernier coup, ou par de la tension quand ça chauffe
const QUIET = /^(me_|oq_|book|opp_book|opp_check|opp_recap|aside|callback|pending|mate_move)/;
// Ces répliques gardent leur humeur même quand la partie s'emballe
const KEEP_MOOD = /^(opp_forgives|blunder_lost|error_lost|blunder_zeitcrit|mate1_zeit)/;
// Sur le dernier coup, ces répliques restent et la fin de partie s'y ajoute ; les autres sont remplacées par le bilan
const KEEP_LAST = /^(blunder|mistake|miss|inaccuracy|hung|missed|allowed|mate1|punish|great|fighting_great|brilliant|comeback|error|gift|opp_(blunder|error|hung|allows|forgives|good|brilliant|punishes|collapse|long_blunder)|rep_)/;
// Paliers de série : le premier coup non trivial qui atteint le palier déclenche la réplique
const MILESTONES = [4, 6, 9, 12, 16, 20, 25, 30];

// Chauffe : chaque gros écart d'éval (dans un sens ou dans l'autre) fait monter la jauge, qui retombe ensuite.
// Elle mesure à quel point la partie est mouvementée, pas le nombre de bons coups.
const HEAT_DECAY = 0.9, HEAT_DECAY_CALM = 0.78;   // « calme » = position déjà jouée
const HEAT_MEMORY = 0.05, HEAT_FLOOR_MAX = 18;    // une partie folle reste un peu tiède
export const HEAT_HOT = 60, HEAT_CRAZY = 85;

/** Calcule le commentaire de chaque position (index 0 = départ, i = après le i-ème demi-coup).
 *  Renvoie un tableau de { text, mood, heat, quiet, key }. */
export function buildComments(g, seed = 0) {
  const rand = rng(seed);
  const pick = picker(rand);
  const moves = g.moves;
  const me = g.my_color;
  const base = g.base_time;
  const LOW = base ? Math.max(20, base * 0.07) : 0;      // zeitnot
  const CRIT = base ? Math.max(8, base * 0.03) : 0;      // panique
  const LONG = base ? Math.max(20, base * 0.08) : Infinity;
  const GAP1 = base ? Math.max(60, base * 0.25) : Infinity, GAP2 = base ? Math.max(120, base * 0.45) : Infinity;
  const myElo = me === 'white' ? g.white_elo : g.black_elo;
  const oppElo = me === 'white' ? g.black_elo : g.white_elo;
  const oppName = me === 'white' ? g.black : g.white;
  const myWp = (m, after) => {
    const w = after ? m.wp_after : m.wp_before;
    return w == null ? 50 : (m.mine ? w : 100 - w);
  };

  // ---- Avant le premier coup : écart Elo, heure de la partie
  const out = [];
  const diff = (oppElo || 0) - (myElo || 0);
  const hour = g.played_at ? new Date(g.played_at * 1000).getHours() : 12;
  let start = diff >= 100 ? 'start_stronger' : diff <= -100 ? 'start_weaker' : 'start';
  if (hour < 6 && rand() < 0.7) start = 'start_night';
  else if (hour >= 22 && start === 'start' && rand() < 0.5) start = 'start_late';
  const hourTxt = hour === 0 ? 'minuit' : hour < 6 ? `${hour} h du matin` : `${hour} h`;
  out.push({
    key: start, mood: 'neutral', heat: 0, quiet: true,
    text: fill(pick(start), { opp: oppName, diff: Math.abs(diff), color: me === 'white' ? 'les Blancs' : 'les Noirs',
      hour: hourTxt, Hour: hourTxt[0].toUpperCase() + hourTxt.slice(1) }),
  });

  // ---- Répertoire : où la prépa s'arrête, était-elle longue, existait-elle déjà ?
  const rep = g.rep;
  const before = !!(rep && rep.before);   // partie jouée avant que la prépa concernée n'existe
  const bookLen = moves.filter(m => m.rc === 'book').length;
  const lens = g.rep_book_lens || [];
  const longer = lens.length ? lens.filter(n => n < bookLen).length / lens.length : 0;
  const repEnd = rep && rep.type === 'end' && rep.ply > 0 ? Math.min(rep.ply, moves.length) - 1 : null;

  const st = {
    streak: 0, bestStreak: 0, errors: 0, blunders: 0, lastBad: -99, lastBlunder: -99, oppErrors: 0, forgiven: 0,
    redemptions: 0, lastRedemption: -99, lowMoves: 0, comebackDone: false, wonMoves: 0, lostMoves: 0, msIdx: 0,
    lastCallback: -99, festDone: false,
    myClock: base, oppClock: base, myLowSaid: false, myCritSaid: false, oppLowSaid: false, oppCritSaid: false,
    advSaid: false, disadvSaid: 0, oppLongSaid: 0, lastOppLong: -99, asides: 0, lastAside: -99, callbacks: 0, memo: null,
    winningFor: 0, losingFor: 0, finishSaid: 0, hangSaid: false, mateSaid: false, queensOff: false, endgame: false,
    myBook: 0, improvAt: null, zeitGood: 0, longGood: 0, lastSpecial: -9, tensions: 0, lastTension: -9,
    declineSaid: false, riseSaid: false, hist: [], chain: 0, fest: 0, everCrit: false,
  };
  let heat = 0, heatTotal = 0;

  moves.forEach((m, i) => {
    const h = m.hint || {};
    const prev = moves[i - 1];
    const next = moves[i + 1];
    const num = Math.floor(i / 2) + 1;
    const wb = myWp(m, false), wa = myWp(m, true);   // mon % de gain avant / après ce demi-coup
    const known = m.wp_before != null && m.wp_after != null;
    if (m.clock != null) { if (m.mine) st.myClock = m.clock; else st.oppClock = m.clock; }
    const myClk = st.myClock, oppClk = st.oppClock;
    const zeit = !!base && myClk != null && myClk < LOW;
    const crit = !!base && myClk != null && myClk < CRIT;
    const oppZeit = !!base && oppClk != null && oppClk < LOW;
    const oppCrit = !!base && oppClk != null && oppClk < CRIT;
    const long = m.spent != null && m.spent >= LONG;
    const fast = m.spent != null && m.spent < 2 && i > 16 && !zeit;
    const opening = i < 16 || m.rc === 'book';
    const mateMove = m.san.includes('#');
    st.chain = m.rc === 'blunder' ? st.chain + 1 : 0;   // gaffes consécutives, des deux camps
    if (!st.chain) st.festDone = false;
    const fest = st.chain >= 3 && !st.festDone && st.fest < 2;
    const v = {
      best: m.best_san || '?', piece: h.piece || 'pièce', next: next?.best_san || 'le bon coup', num, opp: oppName,
      mate: h.missed_mate, amate: h.allowed_mate, mate_in: h.mate_in, spent: fmtSpent(m.spent),
      clock: fmtSpent(m.clock ?? (m.mine ? myClk : oppClk)), my_clock: fmtSpent(myClk), opp_clock: fmtSpent(oppClk),
      was: evalLabel(wb), now: evalLabel(wa), forgiven: st.forgiven,
    };

    // Événements de matériel (échange des dames, entrée en finale), valables pour les deux camps
    const matA = material(m.fen_after);
    let matEvent = null;
    if (!st.queensOff && matA.q === 0 && material(m.fen).q > 0 && prev && material(prev.fen).q === 2) {
      st.queensOff = true; matEvent = 'queens_off';
    } else if (!st.endgame && i >= 20 && matA.pieces <= 13) {
      st.endgame = true;
      matEvent = wa >= 70 ? 'endgame_win' : wa <= 30 ? 'endgame_lose' : 'endgame_eq';
    }

    // Petites respirations : apartés et rappels d'un moment marquant, seulement quand c'est calme
    const canAside = () => st.asides < 2 && i >= 6 && i - st.lastAside >= 14 && heat < 25 && wa >= 30 && wa <= 70 && rand() < 0.06;
    const canCallback = () => st.memo && !st.memo.used && i - st.memo.i >= 10 && i - st.lastCallback >= 16
      && st.callbacks < 2 && heat < 40 && rand() < 0.07;
    const quietName = () => {
      if (canAside()) { st.asides++; st.lastAside = i; return 'aside'; }
      if (canCallback()) {
        st.callbacks++; st.lastCallback = i; st.memo.used = true;
        Object.assign(v, { cb_san: st.memo.san, cb_num: st.memo.num });
        return 'callback_' + st.memo.kind;
      }
      return null;
    };
    // Écart de pendule (une fois dans chaque sens, et une relance si ça devient grave)
    const clockGap = () => {
      if (!base || i <= 20 || myClk == null || oppClk == null) return null;
      const d = oppClk - myClk;
      if (d >= GAP1 && !st.disadvSaid) { st.disadvSaid = 1; v.diff = fmtSpent(d); return 'time_disadv'; }
      if (d >= GAP2 && myClk < 60 && st.disadvSaid === 1) { st.disadvSaid = 2; return 'time_disadv_bad'; }
      if (-d >= GAP1 && !st.advSaid) { st.advSaid = true; v.diff = fmtSpent(-d); return 'time_adv'; }
      return null;
    };

    let name, mood = 'neutral', bonus = 0;

    if (!m.rc) {
      name = 'pending';
    } else if (!m.mine) {
      // ================================================ Coup adverse
      const myPrev = prev && prev.mine ? prev : null;
      const myPrevBad = myPrev && BAD.has(myPrev.rc);
      const myPrevWa = myPrev ? myWp(myPrev, true) : 50;
      if (rep && rep.type === 'uncovered' && rep.ply === i) {
        name = i < 2 ? 'rep_uncovered_early' : 'rep_uncovered'; mood = 'sly';
        if (i >= 3) st.improvAt = i + 1;
      } else if (BAD.has(m.rc)) {
        st.oppErrors++;
        mood = 'sly';
        if (fest) { name = 'blunder_fest'; st.fest++; st.festDone = true; }
        else if (myPrevBad && (myPrev.rc === 'blunder' || myPrevWa < 45)) {
          // Il ne punit pas ma faute : de plus en plus incrédule à chaque fois
          st.forgiven++; v.forgiven = st.forgiven;
          name = st.forgiven >= 3 ? 'opp_forgives_saint' : st.forgiven === 2 ? 'opp_forgives_again' : 'opp_forgives';
          mood = 'happy';
        } else if (h.allowed_mate) { name = h.allowed_mate === 1 ? 'opp_allows_mate1' : 'opp_allows_mate'; mood = 'ecstatic'; }
        else if (h.hung) { name = 'opp_hung'; Object.assign(v, h.hung); }
        else if (oppCrit) name = 'opp_error_zeit';
        else if (long) name = 'opp_long_blunder';
        else if (st.oppErrors >= 4 && rand() < 0.6) name = 'opp_collapse';
        else if (st.oppErrors >= 2 && rand() < 0.5) name = 'opp_error_again';
        else name = m.rc === 'blunder' ? 'opp_blunder' : 'opp_error';
      } else if (myPrevBad && myPrevWa <= 40 && wa <= 40 && (GOOD.has(m.rc) || m.loss < 3)) { name = 'opp_punishes'; mood = 'annoyed'; }
      else if (m.rc === 'brilliant') { name = 'opp_brilliant'; mood = 'annoyed'; }
      else if (m.rc === 'great') name = 'opp_good';
      else if (m.san.includes('=')) { name = 'opp_promote'; mood = wa <= 40 ? 'annoyed' : 'neutral'; }
      else if (matEvent) name = matEvent;
      else if (oppCrit && !st.oppCritSaid) { name = 'opp_zeitcrit'; mood = 'sly'; st.oppCritSaid = st.oppLowSaid = true; }
      else if (oppZeit && !st.oppLowSaid) { name = 'opp_zeitnot'; mood = 'sly'; st.oppLowSaid = true; }
      else if ((name = clockGap())) mood = name === 'time_adv' ? 'sly' : 'annoyed';
      else if (long && st.oppLongSaid < 3 && i - st.lastOppLong >= 8) { name = 'opp_long'; mood = 'sly'; st.oppLongSaid++; st.lastOppLong = i; }
      else if (m.rc === 'book') name = 'opp_book';
      else if (/[+#]/.test(m.san) && rand() < 0.5) name = 'opp_check';
      else if (h.recap && rand() < 0.35) name = 'opp_recap';
      else if (i < 16) name = quietName() || (/^[NB]/.test(m.san) && rand() < 0.6 ? 'oq_dev' : 'oq_open');
      else name = quietName() || (wa >= 75 ? 'oq_win' : wa <= 25 ? 'oq_lose' : 'oq_eq');
    } else {
      // ================================================ Mon coup
      const prevStreak = st.streak;
      const oppErr = prev && !prev.mine && BAD.has(prev.rc) ? prev : null;
      const gift = oppErr && wb >= 60;   // il venait de m'offrir quelque chose
      const undecided = wb > 10 && wb < 90;
      const isDev = rep && rep.ply === i && (rep.type === 'deviation' || rep.type === 'other');
      if (isDev) v.expected = (rep.expected || []).join(' ou ');

      if (ERR.has(m.rc)) {
        st.streak = 0; st.msIdx = 0;
        if (BAD.has(m.rc)) { st.errors++; st.lastBad = i; }
        if (m.rc === 'blunder') { st.blunders++; v.n = st.blunders; }
        if (isDev) {
          name = rep.type === 'other' ? 'rep_other' : 'rep_deviation_bad'; mood = before ? 'sly' : 'angry';
        } else if (m.rc === 'blunder') {
          mood = 'angry';
          if (fest) { name = 'blunder_fest'; mood = 'sly'; st.fest++; st.festDone = true; }
          else if (h.missed_mate === 1) { name = crit ? 'mate1_zeit' : 'missed_mate_1'; mood = crit ? 'angry' : 'furious'; }
          else if (h.allowed_mate === 1 && wb > 15) { name = crit ? 'mate1_zeit' : 'allowed_mate_1'; mood = crit ? 'angry' : 'furious'; }
          else if (wb <= 25) { name = 'blunder_lost'; mood = 'weary'; }
          else if (crit) { name = 'blunder_zeitcrit'; mood = 'annoyed'; }
          else if (oppErr?.hint?.hung && h.missed_capture) { name = 'miss_free_piece'; mood = 'furious'; Object.assign(v, oppErr.hint.hung); }
          else if (gift) { name = oppErr.rc === 'blunder' ? 'blunder_exchange' : 'gift_returned'; mood = 'sly'; }
          else if (h.level >= 3 && h.hung) { name = 'hung'; mood = 'furious'; Object.assign(v, h.hung); }
          else if (h.level >= 3 && h.missed_capture) { name = 'missed_capture'; mood = 'furious'; Object.assign(v, h.missed_capture); }
          else if (zeit) name = 'blunder_zeitnot';
          else if (prevStreak >= 4) { name = 'blunder_after_streak'; v.streak = prevStreak; mood = 'furious'; bonus = 8; }
          else if (wb >= 80) { name = wa <= 55 ? 'blunder_thrown' : 'blunder_spoiled'; mood = wa <= 55 ? 'furious' : 'angry'; }
          else if (st.blunders === 1 && i < 16) name = 'blunder_early';
          else if (long) name = 'blunder_long';
          else if (fast && rand() < 0.7) name = 'blunder_fast';
          else if (st.blunders >= 3) { name = 'blunder_many'; mood = 'furious'; }
          else if (st.blunders === 2) name = 'blunder_again';
          else if (h.missed_mate) name = 'missed_mate_n';
          else if (h.allowed_mate) name = 'allowed_mate_n';
          else if (wb >= 60 && wa >= 40) name = 'blunder_equalize';
          else name = 'blunder';
          st.memo = { kind: 'blunder', san: m.san, num, i };
          st.lastBlunder = i;
        } else {
          mood = m.rc === 'inaccuracy' ? 'neutral' : 'annoyed';
          if (wb <= 15) { name = 'error_lost'; mood = 'weary'; }
          else if (wb >= 90 && wa >= 75) name = 'error_still_winning';
          else if (m.rc === 'miss' && oppErr?.hint?.hung && h.missed_capture) { name = 'miss_free_piece'; mood = 'angry'; Object.assign(v, oppErr.hint.hung); }
          else if (zeit && m.rc !== 'inaccuracy') name = 'error_zeitnot';
          else if (prevStreak >= (m.rc === 'inaccuracy' ? 6 : 4)) { name = 'streak_broken_small'; v.streak = prevStreak; }
          else if (m.rc === 'miss' && h.missed_capture && h.level >= 3) { name = 'missed_capture'; mood = 'angry'; Object.assign(v, h.missed_capture); }
          else if (h.missed_mate && m.rc !== 'inaccuracy') name = 'missed_mate_n';
          else if (h.allowed_mate) { name = 'allowed_mate_n'; mood = 'angry'; }
          else if (st.improvAt === i) { name = 'improv_bad'; mood = 'annoyed'; }
          else if (m.rc === 'mistake' && long) name = 'mistake_long';
          else if (m.rc !== 'inaccuracy' && st.errors >= 4 && rand() < 0.5) name = 'error_pile';
          else name = m.rc;
        }
      } else {
        // Série : seuls comptent les coups joués dans une position encore ouverte, et qui demandaient
        // un vrai choix (quand tous les coups se valent, ce n'est pas un exploit) ; l'ouverture ne compte pas
        const inc = GOOD.has(m.rc);
        const counts = inc && undecided && i >= 10 && (m.gap == null || m.gap >= 0.3 || m.rc !== 'excellent' && m.rc !== 'best');
        if (counts) st.streak++;
        else if (undecided && m.rc === 'good' && m.loss >= 8) { st.streak = 0; st.msIdx = 0; }
        st.bestStreak = Math.max(st.bestStreak, st.streak);
        v.streak = st.streak;
        if (m.rc === 'book') st.myBook++;
        const messy = st.errors >= 2 && i - st.lastBad <= 14 && st.redemptions < 2 && i - st.lastRedemption >= 16 && undecided;
        const milestone = counts && i >= 14 && st.streak >= MILESTONES[st.msIdx] && !h.recap && !h.forced && !crit;
        // Punition : l'adversaire vient de se tromper et je réponds juste
        const punished = oppErr && (inc || m.loss < 2) && wb >= 55;
        const tookPiece = punished && oppErr.hint?.hung && m.san === oppErr.hint.hung.reply;
        const tookMate = punished && oppErr.hint?.allowed_mate && h.mate_in >= 1;
        const comeback = !st.comebackDone && st.lowMoves >= 3 && wa >= 50 && i >= 12;
        if (punished && comeback) st.comebackDone = true;   // la punition raconte déjà le retour
        st.winningFor = wb >= 90 ? st.winningFor + 1 : 0;
        st.losingFor = wb <= 10 ? st.losingFor + 1 : 0;
        // Tendance : l'éval glisse (ou monte) sur mes 5 derniers coups sans faute franche
        const w0 = i >= 20 && st.hist.length >= 5 ? st.hist[st.hist.length - 5] : null;
        const decline = w0 && !st.declineSaid && w0.wa >= 30 && w0.wa <= 85 && w0.wa - wa >= 20
          && !st.hist.slice(-5).some(x => x.bad) && !BAD.has(m.rc);
        const rise = w0 && !st.riseSaid && w0.wa >= 15 && w0.wa <= 70 && wa <= 88 && wa - w0.wa >= 22
          && !moves.slice(w0.i, i).some(x => !x.mine && BAD.has(x.rc));
        mood = 'happy';
        if (isDev) { name = rep.type === 'other' ? 'rep_other' : 'rep_deviation_ok'; mood = before ? 'sly' : 'angry'; }
        else if (mateMove) { name = 'mate_move'; mood = 'ecstatic'; }
        else if (m.rc === 'brilliant') { name = st.blunders ? 'brilliant_redemption' : 'brilliant'; mood = 'ecstatic'; }
        else if (tookMate) { name = 'punish_mate'; mood = 'ecstatic'; st.mateSaid = true; bonus = 10; }
        else if (punished && comeback) { name = 'comeback_punish'; mood = 'ecstatic'; bonus = 12; }
        else if (tookPiece) { name = 'punish_piece'; Object.assign(v, oppErr.hint.hung); bonus = 8; }
        else if (punished && oppErr.rc === 'blunder') { name = 'punish'; mood = 'ecstatic'; bonus = 10; }
        else if (m.rc === 'great' && zeit) { name = 'zeitnot_good'; st.zeitGood++; }
        else if (m.rc === 'great' && messy) { name = 'redemption'; st.redemptions++; st.lastRedemption = i; }
        else if (m.rc === 'great' && wb <= 30) name = 'fighting_great';
        else if (m.rc === 'great' && wb >= 70) name = 'great_keep';
        else if (m.rc === 'great') name = 'great';
        else if (st.improvAt === i && inc) name = 'improv_good';
        else if (punished && rand() < 0.7) name = 'punish_small';
        else if (comeback) { name = wa >= 75 ? 'comeback_full' : 'comeback'; st.comebackDone = true; bonus = 12; mood = wa >= 75 ? 'ecstatic' : 'happy'; }
        else if (milestone) {
          const tier = MILESTONES[st.msIdx];
          name = tier >= 9 ? 'streak3' : tier >= 6 ? 'streak2' : 'streak1';
          if (tier >= 9) mood = 'ecstatic';
          while (st.streak >= MILESTONES[st.msIdx]) st.msIdx++;
        } else if (h.mate_in >= 2 && h.mate_in <= 6 && !st.mateSaid && i >= 10) { name = 'mate_on_board'; st.mateSaid = true; mood = 'sly'; }
        else if (m.san.includes('=')) name = m.san.includes('=Q') ? 'promote' : 'promote_under';
        else if (crit && !st.myCritSaid) { name = 'my_zeitcrit'; mood = 'annoyed'; st.myCritSaid = st.myLowSaid = true; }
        else if (zeit && !st.myLowSaid) { name = 'my_zeitnot'; mood = 'annoyed'; st.myLowSaid = true; }
        else if (h.hard && undecided && zeit) { name = 'zeitnot_good'; st.zeitGood++; }
        else if (messy && h.hard) { name = 'redemption'; st.redemptions++; st.lastRedemption = i; }
        else if (h.hard && undecided) name = long ? 'long_good' : 'hard';
        else if (matEvent) { name = matEvent; mood = 'neutral'; }
        else if (decline) { name = 'slow_decline'; st.declineSaid = true; mood = 'annoyed'; }
        else if (rise) { name = 'slow_rise'; st.riseSaid = true; }
        else if (st.winningFor >= 8 && st.winningFor % 8 === 0 && st.finishSaid < 2) {
          name = h.mate_in && h.mate_in <= 6 ? 'finish_mate' : 'finish_him'; v.n = st.winningFor; st.finishSaid++; mood = 'annoyed';
        } else if (st.losingFor >= 6 && !st.hangSaid) { name = 'hang_in'; st.hangSaid = true; }
        else if ((name = clockGap())) mood = name === 'time_adv' ? 'sly' : 'annoyed';
        else if (zeit && m.rc !== 'good' && m.spent != null && m.spent < 3 && st.zeitGood < 2 && i - st.lastSpecial > 4 && rand() < 0.5) { name = 'zeitnot_fast'; st.zeitGood++; }
        else if (long && m.rc !== 'good' && st.longGood < 2 && i - st.lastSpecial > 4 && rand() < 0.5) { name = 'long_good'; st.longGood++; }
        else if (wb <= 25 && wb > 3 && m.rc !== 'good' && rand() < 0.3) name = 'fighting';
        else if (m.san.startsWith('O-O') && m.rc !== 'book') { name = m.san.startsWith('O-O-O') ? 'castle_long' : num >= 15 ? 'castle_late' : 'castle'; mood = 'neutral'; }
        else if (m.rc === 'book') { name = st.myBook === 1 ? 'book_first' : st.myBook >= 5 && rand() < 0.5 ? 'book_deep' : 'book'; mood = 'neutral'; }
        else {
          mood = 'neutral';
          name = quietName();
          if (!name) {
            const ok = m.rc !== 'good';
            name = wa >= 75 ? (ok ? 'me_win' : 'me_win_good') : wa <= 25 ? (ok ? 'me_lose' : 'me_lose_good') : 'me_' + m.rc;
          }
        }
        if (inc && ['great', 'brilliant'].includes(m.rc)) st.memo = { kind: 'great', san: m.san, num, i };
      }
      if (wa <= 25) st.lowMoves++;
      // Gagnant / perdu « pour de vrai » : la position tient après plusieurs de mes coups
      if (i >= 16 && known && wa >= 85) st.wonMoves++;
      if (i >= 16 && known && wa <= 15) st.lostMoves++;
      st.hist.push({ i, wa, bad: BAD.has(m.rc) });
    }
    if (m.mine && crit) st.everCrit = true;

    // ---- Fin de la prépa : toujours signalée, avec plus ou moins d'enthousiasme
    if (i === repEnd && m.rc && (QUIET.test(name) || name.startsWith('rep_'))) {
      v.book = Math.ceil(bookLen / 2);
      const deep = bookLen >= 7 && (longer >= 0.85 || (g.rep_depth_max && bookLen >= 0.8 * g.rep_depth_max));
      name = deep ? (v.book >= 6 && rand() < 0.5 ? 'rep_end_wow_n' : 'rep_end_wow') : bookLen >= 4 ? 'rep_end_good' : 'rep_end_short';
      mood = before ? 'happy' : deep ? 'ecstatic' : bookLen >= 4 ? 'happy' : 'neutral';
      if (before) name = 'rep_end_before';
    }
    // Partie antérieure à la prépa : pas de reproche, juste un regard sur le répertoire d'aujourd'hui
    if (before && /^(book|opp_book|rep_(other|deviation))/.test(name) && T[name + '_before']) name += '_before';

    // ---- Chauffe : les écarts d'éval font monter la jauge (l'ouverture compte peu)
    const calm = (wb >= 92 && wa >= 92) || (wb <= 8 && wa <= 8);
    const floor = Math.min(HEAT_FLOOR_MAX, heatTotal * HEAT_MEMORY);
    heat = floor + Math.max(0, heat - floor) * (calm ? HEAT_DECAY_CALM : HEAT_DECAY);
    const swing = known ? Math.abs(wa - wb) : 0;
    let gain = (swing >= 8 ? swing * 0.9 : 0) + ({ brilliant: 30, great: 12 }[m.rc] || 0) * (m.mine ? 1 : 0.6) + bonus;
    if (m.mine && crit) gain += 4;
    if (opening) gain *= 0.4;
    heatTotal += gain;
    heat = Math.min(100, heat + gain);

    let quiet = QUIET.test(name);
    if (heat >= HEAT_CRAZY && !quiet && T[name + '_hot']) name += '_hot';
    // Tension : seulement si la partie est mouvementée ET encore indécise, et pas à chaque coup
    if (heat >= HEAT_HOT && quiet && name !== 'pending' && wa > 20 && wa < 80 && i - st.lastTension >= 3
        && st.tensions < 6 && rand() < 0.5) {
      name = m.mine ? 'tension' : 'tension_opp'; st.tensions++; st.lastTension = i;
    }
    if (heat >= HEAT_CRAZY && !quiet && !KEEP_MOOD.test(name)) mood = { angry: 'furious', happy: 'ecstatic', annoyed: 'angry' }[mood] || mood;

    if (m.mine && !quiet) st.lastSpecial = i;
    agree(v);
    quiet = quiet || name.startsWith('tension') || (!m.mine && !BAD.has(m.rc)) || (mateMove && i === moves.length - 1);
    out.push({ key: name, text: fill(pick(name), v), mood, heat: Math.round(heat), quiet });
  });

  // ---- Fin de partie : motif + un seul bilan, ajoutés au dernier coup
  const last = moves[moves.length - 1];
  if (last && last.rc) {
    const myWpEnd = myWp(last, true);
    const acc = g.summary?.[me]?.accuracy;
    const oppAcc = g.summary?.[me === 'white' ? 'black' : 'white']?.accuracy;
    const r = g.end_reason;
    const nGreat = moves.filter(m => m.mine && ['great', 'brilliant'].includes(m.rc)).length;
    const v = {
      n: st.blunders, best_streak: st.bestStreak, acc, opp_acc: oppAcc, piece: last.hint?.piece, opp: oppName,
      num: Math.floor((moves.length - 1) / 2) + 1, my_clock: fmtSpent(st.myClock), opp_clock: fmtSpent(st.oppClock),
      forgiven: st.forgiven, n_great: nGreat,
    };
    agree(v);
    // Écrasement : grosse précision, et bien au-dessus de l'adversaire
    const crushed = (a, b) => a != null && b != null && a >= 80 && a - b >= 25;
    const zeitEnd = base && st.myClock != null && st.myClock < LOW;
    const fastGame = moves.length <= 40;
    let name, mood;
    if (g.my_score === 1) {
      mood = 'happy';
      if (r === 'abandon') name = 'win_abandon';
      else if (r !== 'time' && st.lostMoves >= 2) name = 'win_comeback';
      else if (crushed(acc, oppAcc)) { name = 'win_crushed'; mood = 'ecstatic'; }
      else if (r === 'mate') {
        if (zeitEnd) name = 'win_mate_zeit';
        else if (fastGame) name = 'win_mate_fast';
        else if (last.mine && ['pion', 'cavalier', 'roi', 'fou'].includes(v.piece) && rand() < 0.6) name = 'win_mate_piece';
        else name = 'win_mate';
      } else if (r === 'time') name = myWpEnd < 40 ? 'win_time_stolen' : myWpEnd >= 85 ? 'win_time_winning' : 'win_time';
      else if (st.blunders >= 3) name = 'win_ugly';
      else if (myWpEnd < 70) name = 'win_resign_early';
      else name = 'win_resign';
    } else if (g.my_score === 0) {
      mood = 'annoyed';
      if (r === 'time') {
        if (myWpEnd <= 30) { name = 'loss_time_lost'; mood = 'sly'; }
        else if (myWpEnd >= 70) { name = 'loss_time_won'; mood = 'furious'; }
        else if ((st.oppClock ?? 0) - (st.myClock ?? 0) >= 45) name = 'loss_time_scramble';
        else name = 'loss_time';
      } else if (st.wonMoves >= 2) name = 'loss_thrown';
      else if (crushed(oppAcc, acc)) { name = 'loss_crushed'; mood = 'weary'; }
      else if (acc >= 80 && st.blunders === 0) { name = 'loss_unlucky'; mood = 'weary'; }
      else if (r === 'mate') name = zeitEnd ? 'loss_mate_zeit' : fastGame ? 'loss_mate_fast' : 'loss_mate';
      else if (r === 'abandon') name = 'loss_abandon';
      else if (myWpEnd >= 55) { name = 'loss_resign_early'; mood = 'angry'; }
      else name = 'loss_resign';
    } else {
      mood = 'neutral';
      const wonish = myWpEnd >= 75 || st.wonMoves >= 2, savedish = myWpEnd <= 25 || st.lostMoves >= 2;
      if (r === 'draw_stalemate') {
        name = myWpEnd >= 70 ? 'draw_stalemate_won' : myWpEnd <= 30 ? 'draw_stalemate_saved' : 'draw_stalemate';
        mood = { draw_stalemate_won: 'furious', draw_stalemate_saved: 'ecstatic' }[name] || 'neutral';
      } else if (wonish) { name = 'draw_won'; mood = 'annoyed'; }
      else if (savedish) { name = 'draw_saved'; mood = 'happy'; }
      else name = ['draw_repetition', 'draw_insufficient', 'draw_agreed', 'draw_50', 'draw_time'].includes(r) ? r : 'draw_other';
    }
    // Un seul bilan, le plus parlant
    const myMoves = moves.filter(m => m.mine).length;
    let verdict = null;
    if (st.blunders >= 3) verdict = 'verdict_messy';
    else if (nGreat >= 3) verdict = 'verdict_great';
    else if (st.bestStreak >= 7 && st.blunders <= 1) verdict = 'verdict_streak';
    else if (name.endsWith('crushed')) verdict = null;   // la précision est déjà dans la réplique
    else if (st.forgiven >= 3 && g.my_score >= 0.5) verdict = 'verdict_lucky';
    else if (st.everCrit && g.my_score < 1 && r !== 'time') verdict = 'verdict_clock';
    else if (acc != null && acc >= 88 && myMoves >= 15) verdict = 'verdict_acc_high';
    else if (acc != null && acc < 50 && myMoves >= 15) verdict = 'verdict_acc_low';
    else if (st.blunders === 0 && myMoves >= 15) verdict = 'verdict_clean';
    const lastC = out[out.length - 1];
    let text = fill(pick(name), v);
    // Si le dernier coup méritait déjà sa propre réplique, on la garde et on n'ajoute que le motif de fin ;
    // sinon (coup banal, pendule, finale…), la fin et le bilan la remplacent
    const keep = !lastC.quiet && KEEP_LAST.test(lastC.key);
    if (!keep) {
      if (verdict) text += ' ' + fill(pick(verdict), v);
      lastC.text = text;
    } else lastC.text = `${lastC.text} ${text}`;
    lastC.key += ' + END:' + name + (verdict && !keep ? ' + ' + verdict : '');
    // La fin prend le pas sur l'humeur du coup, sauf si le coup lui-même était déjà explosif
    if (!keep || !['furious', 'ecstatic'].includes(lastC.mood)) lastC.mood = mood;
  }
  return out;
}

// ---------------------------------------------------------------- Le robot

export function robotSvg(mood = 'neutral') {
  const eye = { happy: '#5fae7c', ecstatic: '#26c2a3', neutral: '#c8a96a', annoyed: '#d2b450', sly: '#6f9fd8',
    angry: '#df5656', furious: '#ff3b2f', weary: '#8a8a92' }[mood] || '#c8a96a';
  const star = (cx, cy) => `<path d="M${cx} ${cy - 6} L${cx + 1.8} ${cy - 1.8} L${cx + 6} ${cy} L${cx + 1.8} ${cy + 1.8} L${cx} ${cy + 6} L${cx - 1.8} ${cy + 1.8} L${cx - 6} ${cy} L${cx - 1.8} ${cy - 1.8} Z" fill="${eye}"/>`;
  const eyes = {
    happy: `<path d="M19 30 q5 -6 10 0 M35 30 q5 -6 10 0" stroke="${eye}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
    ecstatic: star(24, 29) + star(40, 29),
    neutral: `<circle cx="24" cy="29" r="4.5" fill="${eye}"/><circle cx="40" cy="29" r="4.5" fill="${eye}"/>`,
    sly: `<rect x="19" y="27" width="10" height="4" rx="2" fill="${eye}"/><rect x="35" y="27" width="10" height="4" rx="2" fill="${eye}"/>`,
    weary: `<path d="M19 29 h10 M35 29 h10" stroke="${eye}" stroke-width="3" stroke-linecap="round"/><path d="M19 32 q5 3 10 0 M35 32 q5 3 10 0" stroke="${eye}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    annoyed: `<circle cx="24" cy="30" r="4" fill="${eye}"/><circle cx="40" cy="30" r="4" fill="${eye}"/><path d="M18 23 h11 M35 23 h11" stroke="#9a9aa2" stroke-width="2.5" stroke-linecap="round"/>`,
    angry: `<circle cx="24" cy="31" r="4.5" fill="${eye}"/><circle cx="40" cy="31" r="4.5" fill="${eye}"/><path d="M17 21 l12 6 M47 21 l-12 6" stroke="#e6e6e9" stroke-width="3" stroke-linecap="round"/>`,
    furious: `<circle cx="24" cy="31" r="5.5" fill="${eye}"/><circle cx="40" cy="31" r="5.5" fill="${eye}"/><circle cx="24" cy="31" r="2" fill="#fff"/><circle cx="40" cy="31" r="2" fill="#fff"/><path d="M16 20 l13 7 M48 20 l-13 7" stroke="#e6e6e9" stroke-width="3.5" stroke-linecap="round"/>`,
  }[mood] || '';
  const mouth = {
    happy: `<path d="M23 39 q9 8 18 0" stroke="${eye}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    ecstatic: `<path d="M22 38 q10 11 20 0 z" fill="${eye}"/>`,
    neutral: `<path d="M25 41 h14" stroke="#9a9aa2" stroke-width="3" stroke-linecap="round"/>`,
    sly: `<path d="M24 41 q9 4 16 -2" stroke="#9a9aa2" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    weary: `<path d="M26 42 q6 -2 12 0" stroke="#9a9aa2" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
    annoyed: `<path d="M25 42 q7 -3 14 0" stroke="#9a9aa2" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    angry: `<path d="M23 44 q9 -7 18 0" stroke="${eye}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    furious: `<rect x="22" y="38" width="20" height="8" rx="2" fill="#140c0c" stroke="${eye}" stroke-width="2"/><path d="M27 38 v8 M32 38 v8 M37 38 v8" stroke="${eye}" stroke-width="1.5"/>`,
  }[mood] || '';
  const steam = mood === 'furious'
    ? `<path class="steam" d="M6 14 q-3 -4 0 -8 q3 -4 0 -8 M58 14 q3 -4 0 -8 q-3 -4 0 -8" stroke="#8a8a92" stroke-width="2" fill="none" stroke-linecap="round"/>` : '';
  const sparkle = mood === 'ecstatic'
    ? `<path class="sparkle" d="M4 18 l2 -5 l2 5 l-2 5 z M56 12 l2 -5 l2 5 l-2 5 z" fill="${eye}"/>` : '';
  return `<svg class="robot ${mood}" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
    ${steam}${sparkle}
    <line x1="32" y1="5" x2="32" y2="13" stroke="#55555d" stroke-width="2.5"/>
    <circle cx="32" cy="5" r="3.5" fill="${eye}"/>
    <rect x="5" y="25" width="5" height="12" rx="2" fill="#3a3a42"/><rect x="54" y="25" width="5" height="12" rx="2" fill="#3a3a42"/>
    <rect x="10" y="13" width="44" height="38" rx="11" fill="#232328" stroke="#3a3a42" stroke-width="2"/>
    <rect x="15" y="19" width="34" height="28" rx="7" fill="#141417"/>
    ${eyes}${mouth}
    <rect x="22" y="53" width="20" height="8" rx="3" fill="#2c2c32"/>
  </svg>`;
}
