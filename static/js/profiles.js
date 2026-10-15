import { api, $, h, esc, toast } from './util.js';

// ---- Profils : bouton en bas de la barre latérale, écran d'accueil au premier lancement ----

let state = { active: null, profiles: [] };

const initial = p => esc((p.name || '?').trim().charAt(0).toUpperCase());
const gamesLabel = p => p.games == null ? '' : `${p.games} partie${p.games > 1 ? 's' : ''}`;

/** Recharge l'appli sur le tableau de bord (toutes les pages relisent la base du nouveau profil). */
function reloadApp() {
  location.hash = '#/';
  location.reload();
}

export async function initProfiles() {
  state = await api('/api/profiles');
  if (!state.active) { welcome(); return false; }
  renderBox();
  return true;
}

function current() { return state.profiles.find(p => p.active); }

function renderBox() {
  const box = $('#profileBox');
  const cur = current();
  box.innerHTML = '';
  const btn = h(`<button class="profile-btn" title="Changer de profil">
    <span class="avatar">${initial(cur)}</span>
    <span class="pname"><b>${esc(cur.name)}</b><small>${esc(cur.chesscom_username || '')}</small></span>
    <span class="chev">▴</span></button>`);
  box.append(btn);
  btn.onclick = e => { e.stopPropagation(); toggleMenu(); };
}

function closeMenu() {
  $('#profileMenu')?.remove();
  document.removeEventListener('click', closeMenu);
}

function toggleMenu() {
  if ($('#profileMenu')) return closeMenu();
  const cur = current();
  const others = state.profiles.filter(p => !p.active);
  const menu = h(`<div class="profile-menu" id="profileMenu">
    <div class="pm-title">Profils</div>
    ${state.profiles.map(p => `<div class="pm-row${p.active ? ' on' : ''}" data-id="${esc(p.id)}">
      <span class="avatar sm">${initial(p)}</span>
      <span class="pname"><b>${esc(p.name)}</b><small>${gamesLabel(p)}</small></span>
      ${p.active ? '<span class="check">✓</span>' : `<button class="pm-del" data-del="${esc(p.id)}" title="Supprimer ce profil">×</button>`}
    </div>`).join('')}
    <div class="pm-sep"></div>
    <button class="pm-item" data-act="new">＋ Nouveau profil…</button>
    <button class="pm-item" data-act="import">⇩ Importer un profil…</button>
    <button class="pm-item" data-act="export">⇧ Exporter « ${esc(cur.name)} »</button>
    <button class="pm-item" data-act="rename">✎ Renommer « ${esc(cur.name)} »</button>
  </div>`);
  menu.addEventListener('click', e => e.stopPropagation());
  $('#profileBox').append(menu);
  setTimeout(() => document.addEventListener('click', closeMenu));

  menu.querySelectorAll('.pm-row:not(.on)').forEach(row => row.onclick = () => switchTo(row.dataset.id));
  menu.querySelectorAll('[data-del]').forEach(b => b.onclick = e => { e.stopPropagation(); removeProfile(others.find(p => p.id === b.dataset.del)); });
  menu.querySelector('[data-act=new]').onclick = () => { closeMenu(); createDialog(); };
  menu.querySelector('[data-act=import]').onclick = () => { closeMenu(); pickImport(); };
  menu.querySelector('[data-act=export]').onclick = () => { closeMenu(); exportProfile(cur); };
  menu.querySelector('[data-act=rename]').onclick = () => { closeMenu(); renameDialog(cur); };
}

async function switchTo(id) {
  closeMenu();
  busy('Changement de profil…');
  try { await api(`/api/profiles/${encodeURIComponent(id)}/activate`, { method: 'POST' }); reloadApp(); }
  catch (e) { busy(null); toast(e.message); }
}

async function removeProfile(p) {
  if (!p) return;
  if (!confirm(`Supprimer le profil « ${p.name} » et toutes ses données (parties, analyses, répertoire, entraînement) ?\nCette action est définitive. Pense à l’exporter avant si tu veux le garder.`)) return;
  try {
    state = await api(`/api/profiles/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    closeMenu(); renderBox(); toast(`Profil « ${p.name} » supprimé`);
  } catch (e) { toast(e.message); }
}

async function exportProfile(p) {
  busy('Export du profil…');
  try {
    const r = await api(`/api/profiles/${encodeURIComponent(p.id)}/export`, { method: 'POST' });
    busy(null);
    toast(`Profil exporté : ${r.path}`, 7000);
  } catch (e) { busy(null); toast(e.message); }
}

// ---- Import ----

function pickImport() {
  const input = h(`<input type="file" accept=".zip,application/zip" hidden>`);
  document.body.append(input);
  input.onchange = () => { const f = input.files[0]; input.remove(); if (f) importFile(f); };
  input.click();
}

async function importFile(file, replace = false) {
  busy('Import du profil…');
  try {
    const r = await fetch(`/api/profiles/import?replace=${replace}`, {
      method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' },
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409 && String(data.detail || '').startsWith('exists:')) {
      busy(null);
      const name = data.detail.slice(7);
      if (confirm(`Le profil « ${name} » existe déjà sur ce PC.\nRemplacer ses données par celles du fichier ? Son répertoire et sa progression d’entraînement actuels seront écrasés.`))
        return importFile(file, true);
      return;
    }
    if (!r.ok) throw new Error(data.detail || r.statusText);
    reloadApp();
  } catch (e) { busy(null); toast(e.message); }
}

// ---- Fenêtres ----

function modal(title, body, okLabel) {
  return new Promise(resolve => {
    const m = h(`<div class="modal-back"><form class="modal panel">
      <h2>${title}</h2>${body}
      <div class="modal-err small" hidden></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Annuler</button>
      <button class="btn btn-primary">${okLabel}</button></div></form></div>`);
    document.body.append(m);
    const form = m.querySelector('form');
    form.querySelector('input')?.focus();
    const done = v => { m.remove(); resolve(v); };
    m.querySelector('[data-cancel]').onclick = () => done(null);
    m.addEventListener('mousedown', e => { if (e.target === m) done(null); });
    m.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
    form.onsubmit = e => {
      e.preventDefault();
      done({ form, error: msg => showErr(m, msg), modal: m });
    };
  });
}

function showErr(m, msg) {
  const el = m.querySelector('.modal-err');
  el.textContent = msg; el.hidden = false;
}

const profileFields = `
  <label>Pseudo Chess.com</label><input type="text" name="user" autocomplete="off" spellcheck="false" required>
  <label>Nom affiché <span class="muted">(facultatif)</span></label><input type="text" name="name" autocomplete="off" maxlength="40">`;

async function submitCreate(form, onError) {
  const body = { chesscom_username: form.user.value.trim(), name: form.name.value.trim() };
  const btn = form.querySelector('.btn-primary');
  btn.disabled = true; btn.textContent = 'Vérification…';
  try { await api('/api/profiles', { body }); reloadApp(); return true; }
  catch (e) { btn.disabled = false; btn.textContent = 'Créer'; onError(e.message); return false; }
}

async function createDialog() {
  const m = h(`<div class="modal-back"><form class="modal panel">
    <h2>Nouveau profil</h2>
    <div class="modal-fields">${profileFields}</div>
    <div class="help">Les parties de ce compte seront importées puis analysées par Stockfish.</div>
    <div class="modal-err small" hidden></div>
    <div class="modal-actions"><button type="button" class="btn btn-ghost" data-cancel>Annuler</button>
    <button class="btn btn-primary">Créer</button></div></form></div>`);
  document.body.append(m);
  const form = m.querySelector('form');
  form.user.focus();
  const close = () => m.remove();
  m.querySelector('[data-cancel]').onclick = close;
  m.addEventListener('mousedown', e => { if (e.target === m) close(); });
  m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  form.onsubmit = e => { e.preventDefault(); submitCreate(form, msg => showErr(m, msg)); };
}

async function renameDialog(p) {
  const r = await modal('Renommer le profil',
    `<div class="modal-fields"><label>Nom affiché</label><input type="text" name="name" maxlength="40" value="${esc(p.name)}" required></div>`, 'Renommer');
  if (!r) return;
  try {
    state = await api(`/api/profiles/${encodeURIComponent(p.id)}/rename`, { body: { name: r.form.name.value } });
    renderBox();
  } catch (e) { toast(e.message); }
}

// ---- Écran d'accueil (aucun profil sur ce PC) ----

function welcome() {
  document.body.classList.add('no-profile');
  const w = h(`<div class="welcome">
    <div class="welcome-in">
      <div class="brand big"><svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M12 2a2.5 2.5 0 0 1 1.6 4.42c1.2.6 2 1.85 2 3.28 0 .63-.16 1.22-.44 1.73H16v2h-1.35l1.1 5.07H17v2.5H7V18.5h1.25l1.1-5.07H8v-2h.84a3.6 3.6 0 0 1-.44-1.73c0-1.43.82-2.68 2-3.28A2.5 2.5 0 0 1 12 2Z"/></svg><span>EchecBase</span></div>
      <p class="muted">Bienvenue ! Pour commencer, importe le profil qu’on t’a envoyé ou crée le tien.</p>
      <div class="welcome-cards">
        <div class="panel">
          <h2>Importer un profil</h2>
          <p class="muted small">Un fichier <span class="mono">EchecBase-….zip</span> : tes parties déjà analysées, prêtes à l’emploi.</p>
          <button class="btn btn-primary" data-import>Choisir le fichier…</button>
        </div>
        <form class="panel">
          <h2>Créer un profil</h2>
          <div class="modal-fields">${profileFields}</div>
          <div class="modal-err small" hidden></div>
          <button class="btn">Créer</button>
        </form>
      </div>
    </div>
  </div>`);
  document.body.append(w);
  w.querySelector('[data-import]').onclick = pickImport;
  const form = w.querySelector('form');
  form.onsubmit = e => {
    e.preventDefault();
    const btn = form.querySelector('.btn');
    btn.classList.add('btn-primary');
    submitCreate(form, msg => showErr(form, msg)).then(ok => { if (!ok) btn.textContent = 'Créer'; });
  };
}

// ---- Voile pendant une opération longue ----

function busy(msg) {
  $('#busyVeil')?.remove();
  if (!msg) return;
  document.body.append(h(`<div class="busy-veil" id="busyVeil"><div><span class="spin"></span> ${esc(msg)}</div></div>`));
}
