import { api, $, $$, toast } from './util.js';
import { initProfiles } from './profiles.js';
import * as dashboard from './pages/dashboard.js';
import * as games from './pages/games.js';
import * as game from './pages/game.js';
import * as problems from './pages/problems.js';
import * as repertoire from './pages/repertoire.js';
import * as training from './pages/training.js';
import * as settings from './pages/settings.js';
import * as brilliants from './pages/brilliants.js';

const routes = [
  [/^\/?$/, dashboard, 'dashboard'],
  [/^\/games$/, games, 'games'],
  [/^\/game\/(.+)$/, game, 'games'],
  [/^\/problems$/, problems, 'problems'],
  [/^\/repertoire\/(white|black)$/, repertoire, 'repertoire'],
  [/^\/training$/, training, 'training'],
  [/^\/settings$/, settings, 'settings'],
  [/^\/brilliants$/, brilliants, 'dashboard'],
];

// Formation : page optionnelle, absente du dépôt public
try {
  const formation = await import('./pages/formation.js');
  routes.push([/^\/formation$/, formation, 'formation'], [/^\/formation\/([^/]+)\/([^/]+)$/, formation, 'formation']);
  $('#nav a[data-route="training"]').insertAdjacentHTML('beforebegin',
    '<a href="#/formation" data-route="formation"><span class="ico">♘</span>Formation</a>');
} catch { }

let cleanup = null;
let renderId = 0;

async function route() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  if (cleanup) { try { cleanup(); } catch { } cleanup = null; }
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  const id = ++renderId;
  for (const [re, page, nav] of routes) {
    const m = path.match(re);
    if (!m) continue;
    $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === nav));
    try {
      const c = await page.render(view, ...m.slice(1).map(decodeURIComponent));
      if (id === renderId) cleanup = c || null; else if (c) c();
    } catch (e) {
      console.error(e);
      view.innerHTML = `<div class="empty">Erreur : ${e.message}</div>`;
    }
    return;
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);

// ---- Synchronisation (barre latérale) ----
let polling = null;
let wasRunning = false;
const listeners = new Set();
export function onSyncDone(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Temps restant lisible : « ~3 min », « ~16 h ». */
function fmtEta(sec) {
  if (sec < 90) return '~1 min';
  if (sec < 5400) return `~${Math.round(sec / 60)} min`;
  return `~${Math.round(sec / 3600)} h`;
}

function showStatus(s) {
  const btn = $('#syncBtn');
  const st = $('#syncStatus');
  const pr = $('#syncProgress');
  btn.textContent = s.running ? 'Arrêter' : 'Synchroniser';
  btn.classList.toggle('btn-primary', !s.running);
  if (s.running) {
    st.innerHTML = `<span class="spin"></span> ${s.step}${s.total ? ` · ${s.done}/${s.total}` : ''}${s.eta ? ` · ${fmtEta(s.eta)}` : ''}`;
    pr.hidden = !s.total;
    pr.firstElementChild.style.width = s.total ? `${100 * s.done / s.total}%` : '0';
  } else {
    pr.hidden = true;
    st.textContent = s.error ? `Erreur : ${s.error}` :
      s.last_run ? `Dernière synchro : ${new Date(s.last_run * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}${s.added ? ` · ${s.added} nouvelles parties` : ''}` : '';
  }
  if (wasRunning && !s.running) {
    listeners.forEach(fn => fn(s));
    toast(s.error ? `Synchronisation : ${s.error}` : 'Synchronisation terminée');
  }
  wasRunning = s.running;
}

export async function pollStatus() {
  const s = await api('/api/status');
  showStatus(s);
  clearTimeout(polling);
  if (s.running) polling = setTimeout(pollStatus, 1200);
  return s;
}

export async function startSync(doImport = true) {
  const r = await api(`/api/sync?do_import=${doImport}`, { method: 'POST' });
  showStatus(r.status);
  pollStatus();
}

$('#syncBtn').addEventListener('click', async () => {
  const s = await api('/api/status');
  if (s.running) { await api('/api/sync/stop', { method: 'POST' }); pollStatus(); }
  else startSync(true);
});

// Premier lancement sans profil : écran d'accueil à la place de l'appli.
if (await initProfiles()) {
  pollStatus();
  route();
}
