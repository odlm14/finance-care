/* Finance_Care — interface (vanilla JS). Même fichier pour la version PC et la version mobile. */
(function () {
  'use strict';
  const FC = window.FC;

  /* ================= Stockage ================= */
  /* Mode « fichiers CSV » : si l'application est lancée via server.js, comptes et données
     sont lus et écrits dans des fichiers CSV (dossier donnees/). Sinon, repli sur le navigateur. */
  /* Version mobile : onedrive.js fournit window.FC_BACKEND (fichiers CSV dans OneDrive). */
  const Backend = window.FC_BACKEND || {
    online: false, cache: {}, timers: {}, pending: {},
    async init() {
      try {
        const r = await fetch('api/accounts', { cache: 'no-store' });
        if (r.ok) { this.cache.fc_accounts = await r.json(); this.online = true; }
      } catch (e) { /* pas de serveur : mode navigateur */ }
    },
    handles(k) { return this.online && (k === 'fc_accounts' || k.startsWith('fc_data_')); },
    url(k) { return k === 'fc_accounts' ? 'api/accounts' : 'api/data/' + encodeURIComponent(k.slice(8)); },
    async loadUser(u) {
      const k = 'fc_data_' + u;
      if (!this.online || this.cache[k]) return;
      try { const r = await fetch(this.url(k), { cache: 'no-store' }); this.cache[k] = r.ok ? await r.json() : null; }
      catch (e) { this.cache[k] = null; }
    },
    write(k, v) {
      this.cache[k] = v; this.pending[k] = true;
      clearTimeout(this.timers[k]);
      this.timers[k] = setTimeout(() => this.flush(k), 200);
    },
    flush(k, keepalive) {
      if (!this.pending[k]) return;
      this.pending[k] = false;
      fetch(this.url(k), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.cache[k]), keepalive: !!keepalive })
        .then((r) => { if (!r.ok) throw new Error(r.status); })
        .catch(() => { this.pending[k] = true; toast("⚠ Impossible d'enregistrer dans les fichiers CSV. Le serveur Finance_Care est-il toujours lancé ?", 'critical', 8000); });
    },
    flushAll(keepalive) { for (const k of Object.keys(this.pending)) { clearTimeout(this.timers[k]); this.flush(k, keepalive); } },
  };
  window.addEventListener('pagehide', () => Backend.flushAll(true));

  const memory = {};
  const Store = {
    get(k) {
      if (Backend.handles(k)) { const v = Backend.cache[k]; return v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)); }
      try { const v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); }
      catch (e) { return k in memory ? JSON.parse(memory[k]) : null; }
    },
    set(k, v) {
      if (Backend.handles(k)) return Backend.write(k, JSON.parse(JSON.stringify(v)));
      const s = JSON.stringify(v);
      try { localStorage.setItem(k, s); } catch (e) { memory[k] = s; }
    },
    del(k) { try { localStorage.removeItem(k); } catch (e) { delete memory[k]; } },
  };
  const Session = {
    get() { try { return sessionStorage.getItem('fc_session') || Store.get('fc_remember'); } catch (e) { return Store.get('fc_remember'); } },
    set(u, remember) {
      try { sessionStorage.setItem('fc_session', u); } catch (e) { /* ignore */ }
      if (remember) Store.set('fc_remember', u);
    },
    clear() { try { sessionStorage.removeItem('fc_session'); } catch (e) { /* ignore */ } Store.del('fc_remember'); },
  };

  async function hashPassword(pw, salt) {
    const txt = salt + ':' + pw;
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      let h = 5381; for (let i = 0; i < txt.length; i++) h = ((h << 5) + h + txt.charCodeAt(i)) | 0;
      return 'djb2-' + (h >>> 0).toString(16);
    }
  }

  /* ================= État ================= */
  const S = { user: null, data: null, month: null, route: 'tableau', filters: {}, onboardStep: 0 };
  const today = () => FC.toISODate(new Date());
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const dataKey = (u) => 'fc_data_' + u;

  function newData(name) {
    return {
      version: 1, onboarded: false,
      profile: { name: name || '', currency: 'EUR', salary: { amount: 0, frequency: 'mensuel', day: 1 } },
      categories: FC.DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      incomes: [], expenses: [], recurring: [], budgets: {}, goals: [],
    };
  }
  function save() { Store.set(dataKey(S.user), S.data); }

  /* ================= Utilitaires d'affichage ================= */
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => FC.fmtMoney(n, S.data ? S.data.profile.currency : 'EUR');
  const pct = (n, d = 0) => (n === null || n === undefined || isNaN(n) ? '—' : Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d }) + ' %');
  const num = (v) => { const n = parseFloat(String(v).replace(',', '.').replace(/\s/g, '')); return isNaN(n) ? 0 : n; };
  function monthLabel(m) {
    const [y, mo] = m.split('-').map(Number);
    const s = new Date(y, mo - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const shortMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '') + ' ' + String(y).slice(2); };
  const dateFr = (d) => { const [y, m, j] = d.split('-'); return `${j}/${m}/${y}`; };
  const cat = (id) => S.data.categories.find((c) => c.id === id) || { id, name: 'Sans catégorie', color: '#adb5bd' };
  const GOAL_TYPES = { vacances: 'Vacances', voiture: 'Voiture', immobilier: 'Achat immobilier', urgence: "Fonds d'urgence", etudes: 'Études', autre: 'Autre' };
  const STATUS = {
    ok: { icon: '✓', label: 'Dans le budget', cls: 'good' },
    warn: { icon: '⚠', label: 'Proche de la limite', cls: 'warning' },
    over: { icon: '✕', label: 'Dépassé', cls: 'critical' },
    none: { icon: '·', label: 'Pas de budget', cls: 'muted' },
  };
  const GOAL_STATUS = {
    atteint: { icon: '★', label: 'Objectif atteint', cls: 'good' },
    bonne_voie: { icon: '✓', label: 'En bonne voie', cls: 'good' },
    retard: { icon: '⚠', label: 'En retard', cls: 'warning' },
    depasse: { icon: '✕', label: 'Date limite passée', cls: 'critical' },
    en_cours: { icon: '·', label: 'Sans date limite', cls: 'muted' },
  };
  const badge = (st) => `<span class="badge ${st.cls}"><span aria-hidden="true">${st.icon}</span> ${st.label}</span>`;

  function toast(msg, level = 'info', ms = 4000) {
    const root = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + level;
    el.setAttribute('role', 'status');
    el.innerHTML = msg;
    root.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
  }

  /* ================= Graphiques SVG ================= */
  let tipEl;
  function showTip(e, html) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tooltip'; document.body.appendChild(tipEl); }
    tipEl.innerHTML = html; tipEl.style.display = 'block';
    const x = Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8);
    const y = Math.min(e.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8);
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) showTip(e, t.getAttribute('data-tip')); else hideTip();
  });

  /* Anneau (donut) : segments [{label, value, color}] — au-delà de 7 segments, regroupement en « Autres ». */
  function donut(segments, opts = {}) {
    let segs = segments.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    if (segs.length > 8) {
      const rest = segs.slice(7);
      segs = segs.slice(0, 7).concat([{ label: 'Autres', value: FC.sum(rest, (s) => s.value), color: '#8d8d8d' }]);
    }
    const total = FC.sum(segs, (s) => s.value);
    const size = opts.size || 180, th = opts.thickness || 26, r = (size - th) / 2, C = 2 * Math.PI * r;
    const gap = segs.length > 1 ? 2 : 0;
    let off = 0;
    const arcs = segs.map((s) => {
      const len = (s.value / total) * C;
      const dash = Math.max(0.5, len - gap);
      const tip = esc(`<strong>${esc(s.label)}</strong><br>${money(s.value)} · ${pct((s.value / total) * 100, 1)}`);
      const el = `<circle class="arc" r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${s.color}" stroke-width="${th}"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-off}" data-tip="${tip}"></circle>`;
      off += len;
      return el;
    }).join('');
    const empty = !segs.length ? `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--grid)" stroke-width="${th}"></circle>` : '';
    const legend = segs.map((s) => `<li><span class="sw" style="background:${s.color}"></span><span class="lg-label">${esc(s.label)}</span><span class="lg-val">${money(s.value)}<small> · ${pct((s.value / total) * 100)}</small></span></li>`).join('');
    return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(opts.aria || 'Graphique en anneau')}">
        <g transform="rotate(-90 ${size / 2} ${size / 2})">${empty}${arcs}</g>
        <text x="50%" y="47%" text-anchor="middle" class="donut-center">${esc(opts.center || '')}</text>
        <text x="50%" y="60%" text-anchor="middle" class="donut-sub">${esc(opts.sub || '')}</text>
      </svg>
      ${segs.length ? `<ul class="legend">${legend}</ul>` : `<p class="muted">${esc(opts.emptyText || 'Aucune donnée')}</p>`}
    </div>`;
  }

  /* Barres groupées : rows [{label, values:[number]}], series [{name, color}] */
  function groupedBars(rows, series, opts = {}) {
    const W = 640, H = opts.height || 220, padL = 56, padB = 26, padT = 10, padR = 8;
    const max = Math.max(1, ...rows.flatMap((r) => r.values));
    const niceMax = niceCeil(max / 4) * 4;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const groupW = plotW / Math.max(1, rows.length);
    const barW = Math.max(3, Math.min(22, (groupW - 10) / series.length - 2));
    const y = (v) => padT + plotH - (v / niceMax) * plotH;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const v = (niceMax / 4) * i;
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="gridline"></line>
            <text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" class="axis">${compact(v)}</text>`;
    }
    rows.forEach((r, i) => {
      const gx = padL + i * groupW + (groupW - (barW + 2) * series.length) / 2;
      const tip = esc(`<strong>${esc(r.tipLabel || r.label)}</strong><br>` + series.map((s, k) => `<span class="sw" style="background:${s.color}"></span> ${esc(s.name)} : ${money(r.values[k])}`).join('<br>'));
      g += `<rect x="${padL + i * groupW}" y="${padT}" width="${groupW}" height="${plotH}" fill="transparent" data-tip="${tip}" class="hit"></rect>`;
      series.forEach((s, k) => {
        const v = r.values[k] || 0; const h = Math.max(0, (v / niceMax) * plotH);
        if (h > 0) g += `<path d="${roundTopBar(gx + k * (barW + 2), padT + plotH, barW, h)}" fill="${s.color}" data-tip="${tip}"></path>`;
      });
      g += `<text x="${padL + i * groupW + groupW / 2}" y="${H - 8}" text-anchor="middle" class="axis">${esc(r.label)}</text>`;
    });
    g += `<line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" class="baseline"></line>`;
    const legend = series.map((s) => `<li><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</li>`).join('');
    return `<ul class="legend inline">${legend}</ul><svg class="bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(opts.aria || 'Graphique en barres')}">${g}</svg>`;
  }
  function roundTopBar(x, base, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + w - r} Q${x + w},${base - h} ${x + w},${base - h + r} V${base} Z`;
  }
  function niceCeil(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
  function compact(v) { return v >= 1000 ? (v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' k' : Math.round(v).toLocaleString('fr-FR'); }

  function progress(pctVal, status) {
    const w = Math.max(0, Math.min(100, pctVal || 0));
    return `<div class="progress ${status || ''}" role="progressbar" aria-valuenow="${Math.round(pctVal || 0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${w}%"></span></div>`;
  }

  /* ================= Modale & formulaires ================= */
  let modalSubmit = null;
  function openModal(title, bodyHtml, onSubmit, submitLabel = 'Enregistrer', opts = {}) {
    modalSubmit = onSubmit;
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-backdrop" data-action="close-modal"></div>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <form data-form="__modal" novalidate>
          <header><h2 id="modal-title">${esc(title)}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Fermer">✕</button></header>
          <div class="modal-body">${bodyHtml}</div>
          <footer>
            <button type="button" class="btn ghost" data-action="close-modal">${opts.cancelLabel || 'Annuler'}</button>
            ${onSubmit ? `<button type="submit" class="btn primary">${esc(submitLabel)}</button>` : ''}
          </footer>
        </form>
      </div>`;
    root.classList.add('open');
    const first = root.querySelector('input:not([type=hidden]),select,textarea');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal() { const r = document.getElementById('modal-root'); r.classList.remove('open'); r.innerHTML = ''; modalSubmit = null; }

  function field(f, v) {
    const val = v === undefined || v === null ? (f.default !== undefined ? f.default : '') : v;
    const id = 'f_' + f.name;
    const req = f.required ? 'required' : '';
    let input;
    if (f.type === 'select') {
      input = `<select id="${id}" name="${f.name}" ${req}>${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (f.type === 'radio') {
      input = `<div class="seg">${f.options.map((o) => `<label><input type="radio" name="${f.name}" value="${esc(o.value)}" ${String(o.value) === String(val) ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div>`;
    } else if (f.type === 'checkbox') {
      return `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${val ? 'checked' : ''}> ${esc(f.label)}</label>`;
    } else if (f.type === 'money') {
      input = `<div class="money-input"><input id="${id}" name="${f.name}" type="number" inputmode="decimal" step="0.01" min="${f.min !== undefined ? f.min : 0}" value="${esc(val)}" ${req} placeholder="0,00"><span>${esc(currencySymbol())}</span></div>`;
    } else {
      input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" ${req} ${f.step ? `step="${f.step}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>`;
    }
    return `<div class="field ${f.wide ? 'wide' : ''}"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input}${f.help ? `<small class="help">${f.help}</small>` : ''}</div>`;
  }
  const fields = (list, values = {}) => `<div class="grid-form">${list.map((f) => field(f, values[f.name])).join('')}</div>`;
  function currencySymbol() {
    try { return (0).toLocaleString('fr-FR', { style: 'currency', currency: S.data.profile.currency }).replace(/[\d\s,.  ]/g, '') || S.data.profile.currency; }
    catch (e) { return S.data ? S.data.profile.currency : '€'; }
  }
  function formObj(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else o[el.name] = el.value;
    }
    return o;
  }
  function requireFields(form, names) {
    for (const n of names) {
      const el = form.elements[n];
      const v = el && (el.value || '').trim();
      if (!v) { if (el && el.focus) el.focus(); toast('Merci de remplir tous les champs obligatoires.', 'warning'); return false; }
    }
    return true;
  }
  const catOptions = () => S.data.categories.map((c) => ({ value: c.id, label: c.name }));
  const freqOptions = () => Object.entries(FC.FREQUENCIES).map(([k, v]) => ({ value: k, label: v.label }));
  function defaultDateFor(month) { return FC.monthOf(today()) === month ? today() : month + '-01'; }

  /* ================= Authentification ================= */
  function renderAuth(mode = 'login') {
    const accounts = Store.get('fc_accounts') || {};
    const hasAccounts = Object.keys(accounts).length > 0;
    if (!hasAccounts) mode = 'register';
    document.getElementById('app').innerHTML = `
      <div class="auth">
        <div class="auth-card">
          <div class="brand big"><span class="logo">FC</span> Finance_Care</div>
          <p class="muted">Suivez vos revenus et vos dépenses, maîtrisez votre budget et atteignez vos objectifs d'épargne.</p>
          <div class="tabs">
            <button class="tab ${mode === 'login' ? 'active' : ''}" data-action="auth-mode" data-mode="login" ${hasAccounts ? '' : 'disabled'}>Se connecter</button>
            <button class="tab ${mode === 'register' ? 'active' : ''}" data-action="auth-mode" data-mode="register">Créer un compte</button>
          </div>
          <form data-form="${mode}" novalidate>
            ${mode === 'register' ? field({ name: 'name', label: 'Votre prénom', required: true }) : ''}
            ${field({ name: 'username', label: "Nom d'utilisateur", required: true })}
            ${field({ name: 'password', label: 'Mot de passe', type: 'password', required: true, help: mode === 'register' ? '6 caractères minimum' : '' })}
            ${mode === 'register' ? field({ name: 'password2', label: 'Confirmer le mot de passe', type: 'password', required: true }) : ''}
            ${field({ name: 'remember', label: 'Rester connecté sur cet appareil', type: 'checkbox' }, true)}
            <button class="btn primary block" type="submit">${mode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
          </form>
          <p class="fineprint">${Backend.authNote || ((Backend.online ? 'Vos données sont enregistrées dans des fichiers CSV sur cet ordinateur (dossier « donnees »).' : 'Mode navigateur : vos données restent dans ce navigateur.') + " Aucune information n'est envoyée sur Internet.")}</p>
        </div>
      </div>`;
  }

  async function doRegister(o, form) {
    if (!requireFields(form, ['name', 'username', 'password', 'password2'])) return;
    const u = o.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,40}$/.test(u)) return toast("Le nom d'utilisateur ne peut contenir que des lettres minuscules sans accent, des chiffres, « . », « _ » ou « - ».", 'warning');
    const accounts = Store.get('fc_accounts') || {};
    if (accounts[u]) return toast("Ce nom d'utilisateur existe déjà.", 'warning');
    if (o.password.length < 6) return toast('Le mot de passe doit contenir au moins 6 caractères.', 'warning');
    if (o.password !== o.password2) return toast('Les mots de passe ne correspondent pas.', 'warning');
    const salt = uid();
    accounts[u] = { salt, hash: await hashPassword(o.password, salt), createdAt: today() };
    Store.set('fc_accounts', accounts);
    Store.set(dataKey(u), newData(o.name.trim()));
    await login(u, o.remember);
  }
  async function doLogin(o, form) {
    if (!requireFields(form, ['username', 'password'])) return;
    const u = o.username.trim().toLowerCase();
    const acc = (Store.get('fc_accounts') || {})[u];
    if (!acc || (await hashPassword(o.password, acc.salt)) !== acc.hash) return toast("Nom d'utilisateur ou mot de passe incorrect.", 'warning');
    await login(u, o.remember);
  }
  async function login(u, remember) {
    await Backend.loadUser(u);
    Session.set(u, remember);
    S.user = u;
    S.data = Store.get(dataKey(u)) || newData(u);
    migrate(S.data);
    S.month = FC.monthOf(today());
    const added = FC.applyRecurring(S.data, today(), uid);
    save();
    if (added) setTimeout(() => toast(`${added} dépense(s) récurrente(s) ajoutée(s) automatiquement.`, 'info'), 300);
    S.route = S.data.onboarded ? (location.hash.slice(1) || 'tableau') : 'bienvenue';
    render();
  }
  function migrate(d) {
    d.recurring = d.recurring || []; d.budgets = d.budgets || {}; d.goals = d.goals || [];
    d.incomes = d.incomes || []; d.expenses = d.expenses || []; d.categories = d.categories || FC.DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  }
  function logout() { Session.clear(); S.user = null; S.data = null; location.hash = ''; renderAuth('login'); }

  /* ================= Mise en page ================= */
  const NAV = [
    ['tableau', 'Tableau de bord', '◎'], ['revenus', 'Revenus', '↓'], ['depenses', 'Dépenses', '↑'],
    ['budget', 'Budget', '▤'], ['epargne', 'Épargne', '◆'], ['historique', 'Historique & bilan', '◷'], ['parametres', 'Paramètres', '⚙'],
  ];
  function monthNav() {
    const cur = FC.monthOf(today());
    return `<div class="month-nav">
      <button class="icon-btn" data-action="month" data-delta="-1" aria-label="Mois précédent">‹</button>
      <strong>${monthLabel(S.month)}</strong>
      <button class="icon-btn" data-action="month" data-delta="1" aria-label="Mois suivant">›</button>
      ${S.month !== cur ? `<button class="btn small ghost" data-action="month-today">Mois en cours</button>` : ''}
    </div>`;
  }
  function render() {
    if (!S.user) return renderAuth();
    if (!S.data.onboarded) S.route = 'bienvenue';
    if (S.route === 'bienvenue') return renderOnboarding();
    const views = { tableau: viewDashboard, revenus: viewIncomes, depenses: viewExpenses, budget: viewBudget, epargne: viewSavings, historique: viewHistory, parametres: viewSettings };
    const view = views[S.route] || viewDashboard;
    const title = (NAV.find((n) => n[0] === S.route) || NAV[0])[1];
    const showMonth = ['tableau', 'revenus', 'depenses', 'budget', 'historique'].includes(S.route);
    document.getElementById('app').innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <div class="brand"><span class="logo">FC</span> Finance_Care</div>
          <nav>${NAV.map(([k, l, i]) => `<a href="#${k}" class="${S.route === k ? 'active' : ''}"><span class="nav-ic" aria-hidden="true">${i}</span>${l}</a>`).join('')}</nav>
          <div class="user">Bonjour ${esc(S.data.profile.name || S.user)}<button class="btn small ghost" data-action="logout">Déconnexion</button></div>
        </aside>
        <main>
          <header class="topbar"><h1>${title}</h1>${showMonth ? monthNav() : ''}
            <div class="quick">
              <button class="btn" data-action="add-income">+ Revenu</button>
              <button class="btn primary" data-action="add-expense">+ Dépense</button>
            </div>
          </header>
          <div class="content">${view()}</div>
        </main>
      </div>`;
  }

  /* ================= Accueil / configuration (flux §4, étapes 1 à 4) ================= */
  function renderOnboarding() {
    const d = S.data, step = S.onboardStep;
    const steps = ['Profil & salaire', 'Budget & catégories', "Objectifs d'épargne", 'Récapitulatif'];
    let body = '';
    if (step === 0) {
      body = `<form data-form="onb-profile" novalidate>
        <h2>Vos informations financières</h2>
        <p class="muted">Commençons par votre salaire : Finance_Care s'en sert pour calculer automatiquement la part à épargner à chaque versement.</p>
        ${fields([
          { name: 'name', label: 'Prénom', required: true },
          { name: 'currency', label: 'Devise', type: 'select', options: [['EUR', 'Euro (€)'], ['CHF', 'Franc suisse (CHF)'], ['CAD', 'Dollar canadien ($ CA)'], ['USD', 'Dollar américain ($)'], ['XOF', 'Franc CFA (XOF)'], ['MAD', 'Dirham marocain (MAD)'], ['GBP', 'Livre sterling (£)']].map(([value, label]) => ({ value, label })) },
          { name: 'amount', label: 'Salaire net par versement', type: 'money', required: true },
          { name: 'frequency', label: 'Fréquence de versement', type: 'select', options: freqOptions() },
          { name: 'day', label: 'Jour de versement (mensuel)', type: 'number', min: 1, max: 31 },
        ], { name: d.profile.name, currency: d.profile.currency, amount: d.profile.salary.amount || '', frequency: d.profile.salary.frequency, day: d.profile.salary.day })}
        ${field({ name: 'recordSalary', label: 'Enregistrer aussi le salaire de ce mois dans mes revenus', type: 'checkbox' }, true)}
        <div class="actions"><button class="btn primary" type="submit">Continuer</button></div>
      </form>`;
    } else if (step === 1) {
      const b = FC.budgetFor(d, FC.monthOf(today()));
      const salary = FC.monthlySalary(d);
      body = `<form data-form="onb-budget" novalidate>
        <h2>Votre budget mensuel</h2>
        <p class="muted">Indiquez le montant total que vous prévoyez de dépenser par mois, puis répartissez-le par catégorie (facultatif). Salaire mensuel estimé : <strong>${money(salary)}</strong>.</p>
        ${fields([{ name: 'global', label: 'Budget mensuel global', type: 'money', required: true, help: salary ? `Suggestion 50/30/20 : ${money(salary * 0.8)} de dépenses, ${money(salary * 0.2)} d'épargne` : '' }], { global: b.global || '' })}
        <h3>Budget par catégorie</h3>
        <div class="grid-form">${d.categories.map((c) => field({ name: 'cat_' + c.id, label: c.name, type: 'money' }, (b.categories || {})[c.id] || '')).join('')}</div>
        <p class="help">Vous pourrez ajouter, renommer ou supprimer des catégories dans les paramètres.</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="onb-step" data-step="0">Retour</button><button class="btn primary" type="submit">Continuer</button></div>
      </form>`;
    } else if (step === 2) {
      body = `<h2>Vos objectifs d'épargne</h2>
        <p class="muted">Créez un ou plusieurs objectifs. Finance_Care calcule combien épargner chaque mois et quel pourcentage de votre salaire y consacrer.</p>
        ${d.goals.length ? `<ul class="simple-list">${d.goals.map((g) => { const st = FC.goalStats(g, today(), d); return `<li><strong>${esc(g.name)}</strong> — ${money(g.target)}${g.deadline ? ' avant le ' + dateFr(g.deadline) : ''}<span class="muted"> · ${st.monthlyNeeded !== null ? money(st.monthlyNeeded) + '/mois' : ''} ${st.recommendedPercent !== null ? '(' + pct(st.recommendedPercent, 1) + ' du salaire)' : ''}</span></li>`; }).join('')}</ul>` : '<p class="empty">Aucun objectif pour le moment.</p>'}
        <div class="actions"><button class="btn" data-action="add-goal">+ Ajouter un objectif</button></div>
        <div class="actions"><button class="btn ghost" data-action="onb-step" data-step="1">Retour</button><button class="btn primary" data-action="onb-goals-done">Continuer</button></div>`;
    } else {
      const a = FC.salaryAllocation(d, FC.monthOf(today()));
      body = `<h2>Tout est prêt !</h2>
        <p class="muted">Voici comment votre salaire mensuel est réparti. Vous pourrez ajuster les pourcentages dans l'onglet Épargne.</p>
        ${allocationTable(a)}
        <div class="actions"><button class="btn ghost" data-action="onb-step" data-step="2">Retour</button><button class="btn primary" data-action="onb-finish">Accéder au tableau de bord</button></div>`;
    }
    document.getElementById('app').innerHTML = `<div class="onboarding">
      <div class="brand"><span class="logo">FC</span> Finance_Care</div>
      <ol class="stepper">${steps.map((s, i) => `<li class="${i === step ? 'active' : i < step ? 'done' : ''}"><span>${i + 1}</span>${s}</li>`).join('')}</ol>
      <div class="card">${body}</div>
      <p class="center"><button class="btn small ghost" data-action="onb-skip">Passer la configuration</button></p>
    </div>`;
  }
  function onbProfile(o, form) {
    if (!requireFields(form, ['name', 'amount'])) return;
    const d = S.data;
    d.profile.name = o.name.trim(); d.profile.currency = o.currency;
    d.profile.salary = { amount: num(o.amount), frequency: o.frequency, day: Math.min(31, Math.max(1, parseInt(o.day, 10) || 1)) };
    if (o.recordSalary && num(o.amount) > 0) {
      const m = FC.monthOf(today());
      if (!d.incomes.some((i) => i.type === 'salaire' && FC.monthOf(i.date) === m)) {
        d.incomes.push({ id: uid(), date: today(), amount: num(o.amount), type: 'salaire', label: 'Salaire' });
      }
    }
    save(); S.onboardStep = 1; render();
  }
  function onbBudget(o, form) {
    if (!requireFields(form, ['global'])) return;
    saveBudgetFrom(o, FC.monthOf(today()));
    S.onboardStep = 2; render();
  }
  function saveBudgetFrom(o, month) {
    const cats = {};
    for (const c of S.data.categories) { const v = num(o['cat_' + c.id]); if (v > 0) cats[c.id] = v; }
    S.data.budgets[month] = { global: num(o.global), categories: cats };
    save();
  }

  /* ================= Tableau de bord (2.6) ================= */
  function viewDashboard() {
    const d = S.data, t = today(), m = S.month;
    const s = FC.monthSummary(d, m, t);
    const f = FC.forecast(d, m, t);
    const a = FC.salaryAllocation(d, m);
    const goals = d.goals.filter((g) => !g.archived);
    const totalSaved = FC.sum(goals, (g) => FC.goalSaved(g));
    const isCurrent = m === FC.monthOf(t);

    const alerts = s.alerts.length ? `<div class="alerts">${s.alerts.map((al) => `<div class="alert ${al.level === 'over' ? 'critical' : 'warning'}"><span aria-hidden="true">${al.level === 'over' ? '✕' : '⚠'}</span><strong>${al.level === 'over' ? 'Dépassement' : 'Attention'}</strong> ${esc(al.text)}</div>`).join('')}</div>` : '';

    const kpis = `<div class="kpis">
      ${kpi('Solde disponible du mois', money(s.balance), 'Revenus − dépenses − épargne', s.balance < 0 ? 'neg' : 'hero')}
      ${kpi('Revenus', money(s.totalIncome), `${s.incomes.length} entrée(s)`)}
      ${kpi('Dépenses', money(s.totalExpenses), `Fixes ${money(s.fixed)} · variables ${money(s.variable)}`)}
      ${kpi('Épargne du mois', money(s.savings), `Épargne totale : ${money(totalSaved)}`)}
      ${kpi('Reste à dépenser (budget)', s.budget.global ? money(s.budget.remaining) : '—', s.budget.global ? `sur ${money(s.budget.global)}${s.pendingTotal ? ` · ${money(s.pendingTotal)} de récurrentes à venir` : ''}` : '<a href="#budget">Définir un budget</a>', s.budget.global && s.budget.remaining < 0 ? 'neg' : '')}
    </div>`;

    const fc = `<div class="card">
      <h2>Prévision de fin de mois</h2>
      ${m < FC.monthOf(t) ? '<p class="muted">Mois terminé : le solde final est connu.</p>' : ''}
      <div class="forecast-main"><span>Solde estimé au ${FC.daysInMonth(m)} ${monthLabel(m).toLowerCase()}</span><strong class="${f.endBalance < 0 ? 'neg' : ''}">${money(f.endBalance)}</strong></div>
      <table class="mini">
        <tr><td>Solde actuel du mois</td><td>${money(f.currentBalance)}</td></tr>
        <tr><td>+ Salaire encore attendu</td><td>${money(f.expectedIncome)}</td></tr>
        <tr><td>− Dépenses récurrentes à venir</td><td>${money(f.plannedFixed)}</td></tr>
        <tr><td>− Épargne prévue restante</td><td>${money(f.plannedSavings)}</td></tr>
        ${isCurrent && f.projectedVariable > 0 ? `<tr class="muted"><td>Si vos dépenses variables continuent au même rythme (${money(f.projectedVariable)} de plus)</td><td>${money(f.endBalanceWithPace)}</td></tr>` : ''}
      </table>
      ${isCurrent && f.perDayLeft !== null ? `<p class="hint">Vous pouvez encore dépenser environ <strong>${money(f.perDayLeft)} par jour</strong> pendant les ${f.daysLeft} jour(s) restants.</p>` : ''}
    </div>`;

    const catSegs = s.byCategory.filter((c) => c.spent > 0).map((c) => ({ label: c.name, value: c.spent, color: c.color }));
    const top = [...s.byCategory].filter((c) => c.spent > 0).sort((x, y) => y.spent - x.spent).slice(0, 5);
    const catCard = `<div class="card">
      <h2>Dépenses par catégorie</h2>
      ${donut(catSegs, { center: money(s.totalExpenses), sub: 'dépensés', emptyText: 'Aucune dépense ce mois-ci.', aria: 'Répartition des dépenses par catégorie' })}
      ${top.length ? `<h3>Principales catégories</h3>${top.map((c) => budgetRow(c)).join('')}` : ''}
    </div>`;

    const allocSegs = [{ label: 'Dépenses (budget)', value: a.expenses, color: FC.PALETTE[0] }, { label: 'Épargne', value: a.savings, color: FC.PALETTE[1] }, { label: 'Disponible', value: Math.max(0, a.available), color: FC.PALETTE[2] }];
    const allocCard = `<div class="card">
      <h2>Répartition du salaire</h2>
      ${a.salary ? donut(allocSegs, { center: money(a.salary), sub: 'par mois', aria: 'Répartition du salaire' }) : '<p class="empty">Renseignez votre salaire dans les <a href="#parametres">paramètres</a>.</p>'}
      ${a.overAllocated ? `<div class="alert critical"><span aria-hidden="true">✕</span><strong>Attention</strong> Budget + épargne dépassent votre salaire de ${money(-a.available)}.</div>` : ''}
      ${a.salary && a.perGoal.length ? `<table class="mini">${a.perGoal.map((g) => `<tr><td>${esc(g.name)}</td><td>${pct(g.percent, 1)}</td><td>${money(g.perSalary)} / salaire</td></tr>`).join('')}</table>` : ''}
    </div>`;

    const goalsCard = `<div class="card">
      <h2>Objectifs d'épargne</h2>
      ${goals.length ? goals.map((g) => { const st = FC.goalStats(g, t, d); return `<div class="goal-line">
        <div class="row"><strong>${esc(g.name)}</strong>${badge(GOAL_STATUS[st.status])}</div>
        ${progress(st.pct, st.status === 'retard' || st.status === 'depasse' ? 'warn' : 'goal')}
        <div class="row small muted"><span>${money(st.saved)} / ${money(st.target)} (${pct(st.pct)})</span><span>${st.remaining > 0 && st.monthlyNeeded !== null ? money(st.monthlyNeeded) + ' / mois nécessaires' : ''}</span></div>
      </div>`; }).join('') : '<p class="empty">Aucun objectif. <a href="#epargne">Créer un objectif</a></p>'}
    </div>`;

    return `${alerts}${kpis}
      <div class="card summary"><h2>Résumé de ${monthLabel(m).toLowerCase()}</h2>${summaryText(s, f, a, goals, t)}</div>
      <div class="grid2">${fc}${allocCard}</div>
      <div class="grid2">${catCard}${goalsCard}</div>`;
  }
  function kpi(label, value, sub, cls = '') { return `<div class="kpi ${cls}"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span><span class="kpi-sub">${sub || ''}</span></div>`; }
  function budgetRow(c) {
    const st = STATUS[c.status];
    return `<div class="budget-row">
      <div class="row"><span><span class="sw" style="background:${c.color}"></span>${esc(c.name)}</span><span>${money(c.spent)}${c.budget ? ` <span class="muted">/ ${money(c.budget)}</span>` : ''}</span></div>
      ${c.budget ? progress(c.pct, c.status) : ''}
      ${c.budget ? `<div class="row small"><span class="muted">${c.remaining >= 0 ? 'Reste ' + money(c.remaining) : 'Dépassement de ' + money(-c.remaining)}${c.planned ? ` · ${money(c.planned)} prévus` : ''}</span>${c.status !== 'ok' ? badge(st) : ''}</div>` : ''}
    </div>`;
  }
  function summaryText(s, f, a, goals, t) {
    const lines = [];
    lines.push(`Ce mois-ci, vous avez reçu <strong>${money(s.totalIncome)}</strong> et dépensé <strong>${money(s.totalExpenses)}</strong>${s.savings ? `, et mis <strong>${money(s.savings)}</strong> de côté (${pct(s.savingsRate)} de vos revenus)` : ''}.`);
    const topCat = [...s.byCategory].sort((x, y) => y.spent - x.spent)[0];
    if (topCat && topCat.spent > 0) lines.push(`Votre premier poste de dépenses est <strong>${esc(topCat.name)}</strong> (${money(topCat.spent)}, ${pct((topCat.spent / s.totalExpenses) * 100)} du total).`);
    if (s.budget.global) {
      lines.push(s.budget.remaining >= 0
        ? `Vous pouvez encore dépenser <strong>${money(s.budget.remaining)}</strong> avant d'atteindre votre budget${s.pendingTotal ? `, dont ${money(s.pendingTotal)} déjà réservés pour les dépenses récurrentes à venir` : ''}.`
        : `Votre budget est dépassé de <strong>${money(-s.budget.remaining)}</strong>.`);
    }
    if (a.salary && a.perGoal.length) lines.push(`À chaque salaire, mettez <strong>${money(a.savings / FC.perMonth(a.frequency))}</strong> de côté (${pct(a.savingsPercent, 1)} de votre salaire).`);
    const late = goals.map((g) => ({ g, st: FC.goalStats(g, t, S.data) })).filter((x) => x.st.status === 'retard');
    if (goals.length) lines.push(late.length ? `Objectif(s) en retard : ${late.map((x) => `<strong>${esc(x.g.name)}</strong>`).join(', ')}. Pensez à <a href="#epargne">ajuster vos pourcentages</a>.` : 'Vous êtes en bonne voie pour atteindre vos objectifs d\'épargne.');
    lines.push(`Solde estimé en fin de mois : <strong class="${f.endBalance < 0 ? 'neg' : ''}">${money(f.endBalance)}</strong>.`);
    return `<ul class="summary-list">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
  }

  /* ================= Revenus (2.1) ================= */
  function viewIncomes() {
    const d = S.data, m = S.month, all = S.filters.incomesAll;
    const list = d.incomes.filter((i) => all || FC.monthOf(i.date) === m).sort((x, y) => y.date.localeCompare(x.date));
    const s = FC.monthSummary(d, m, today());
    const extra = FC.round2(s.totalIncome - s.salaryIncome);
    return `<div class="kpis">
        ${kpi('Revenu total du mois', money(s.totalIncome), monthLabel(m), 'hero')}
        ${kpi('Salaires', money(s.salaryIncome))}
        ${kpi('Revenus supplémentaires', money(extra))}
        ${kpi('Salaire prévu', money(FC.monthlySalary(d)), FC.FREQUENCIES[d.profile.salary.frequency].label + ' · <a href="#parametres">modifier</a>')}
      </div>
      <div class="card">
        <div class="card-head"><h2>Historique des revenus</h2>
          <div class="seg small"><label><input type="radio" name="incall" data-change="incomes-all" value="0" ${all ? '' : 'checked'}><span>Ce mois</span></label><label><input type="radio" name="incall" data-change="incomes-all" value="1" ${all ? 'checked' : ''}><span>Tout l'historique</span></label></div>
        </div>
        ${list.length ? txTable(list.map((i) => ({ id: i.id, date: i.date, label: i.label || (i.type === 'salaire' ? 'Salaire' : 'Revenu'), tag: i.type === 'salaire' ? 'Salaire' : 'Supplémentaire', amount: i.amount })), 'income', all) : '<p class="empty">Aucun revenu enregistré pour cette période.</p>'}
      </div>`;
  }
  function txTable(rows, kind, grouped) {
    let html = '<table class="tx"><thead><tr><th>Date</th><th>Libellé</th><th>Type</th><th class="num">Montant</th><th></th></tr></thead><tbody>';
    let lastMonth = null;
    for (const r of rows) {
      const mo = FC.monthOf(r.date);
      if (grouped && mo !== lastMonth) {
        const tot = FC.sum(rows.filter((x) => FC.monthOf(x.date) === mo), (x) => x.amount);
        html += `<tr class="group"><td colspan="3">${monthLabel(mo)}</td><td class="num">${money(tot)}</td><td></td></tr>`;
        lastMonth = mo;
      }
      html += `<tr><td>${dateFr(r.date)}</td><td>${r.dot ? `<span class="sw" style="background:${r.dot}"></span>` : ''}${esc(r.label)}${r.recurring ? ' <span class="tag" title="Dépense récurrente">↻</span>' : ''}</td>
        <td>${r.tagHtml || `<span class="tag">${esc(r.tag)}</span>`}</td><td class="num">${money(r.amount)}</td>
        <td class="row-actions"><button class="icon-btn" data-action="edit-${kind}" data-id="${r.id}" aria-label="Modifier">✎</button><button class="icon-btn" data-action="del-${kind}" data-id="${r.id}" aria-label="Supprimer">🗑</button></td></tr>`;
    }
    return html + '</tbody></table>';
  }
  function incomeForm(inc) {
    const i = inc || { date: defaultDateFor(S.month), type: 'salaire', label: '', amount: inc ? inc.amount : (S.data.profile.salary.amount || '') };
    openModal(inc ? 'Modifier le revenu' : 'Ajouter un revenu', fields([
      { name: 'type', label: 'Type de revenu', type: 'radio', options: [{ value: 'salaire', label: 'Salaire' }, { value: 'supplementaire', label: 'Revenu supplémentaire' }] },
      { name: 'amount', label: 'Montant', type: 'money', required: true },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'label', label: 'Libellé', placeholder: 'ex. Salaire, prime, freelance…' },
    ], i) + (!inc && S.data.goals.some((g) => Number(g.percent) > 0) ? field({ name: 'split', label: "Si c'est un salaire : répartir automatiquement l'épargne vers mes objectifs", type: 'checkbox' }, true) : ''),
    (o, form) => {
      if (!requireFields(form, ['amount', 'date'])) return;
      const rec = { date: o.date, amount: FC.round2(num(o.amount)), type: o.type || 'supplementaire', label: o.label.trim() };
      if (rec.amount <= 0) return toast('Le montant doit être positif.', 'warning');
      if (inc) Object.assign(inc, rec); else S.data.incomes.push({ id: uid(), ...rec });
      save(); closeModal(); S.month = FC.monthOf(rec.date); render();
      toast(inc ? 'Revenu modifié.' : 'Revenu enregistré.', 'good');
      if (!inc && o.split && rec.type === 'salaire') splitSalaryModal(rec.amount, rec.date);
    });
  }
  function splitSalaryModal(amount, date) {
    const parts = FC.splitSalary(S.data, amount);
    if (!parts.length) return;
    openModal("Répartir l'épargne de ce salaire",
      `<p class="muted">Selon vos pourcentages, voici les montants à mettre de côté sur ce salaire de <strong>${money(amount)}</strong>. Vous pouvez les ajuster.</p>
      <div class="grid-form">${parts.map((p) => field({ name: 'g_' + p.goalId, label: p.name, type: 'money' }, p.amount)).join('')}</div>
      <p class="help">Total : ${money(FC.sum(parts, (p) => p.amount))}</p>`,
      (o) => {
        let total = 0;
        for (const p of parts) {
          const v = FC.round2(num(o['g_' + p.goalId]));
          if (v > 0) { addContribution(p.goalId, v, date, 'Épargne sur salaire'); total += v; }
        }
        save(); closeModal(); render();
        toast(`${money(total)} versés vers vos objectifs d'épargne.`, 'good');
      }, 'Verser', { cancelLabel: 'Plus tard' });
  }

  /* ================= Dépenses (2.2) & récurrentes (3.1) ================= */
  function viewExpenses() {
    const d = S.data, m = S.month, F = S.filters;
    let list = d.expenses.filter((e) => F.expensesAll || FC.monthOf(e.date) === m);
    if (F.expCat) list = list.filter((e) => e.categoryId === F.expCat);
    if (F.expKind) list = list.filter((e) => e.kind === F.expKind);
    list.sort((x, y) => y.date.localeCompare(x.date));
    const s = FC.monthSummary(d, m, today());
    const rec = d.recurring;
    return `<div class="kpis">
        ${kpi('Total des dépenses du mois', money(s.totalExpenses), monthLabel(m), 'hero')}
        ${kpi('Dépenses fixes', money(s.fixed))}
        ${kpi('Dépenses variables', money(s.variable))}
        ${kpi('Récurrentes à venir', money(s.pendingTotal), `${s.pending.length} prévue(s) ce mois-ci`)}
      </div>
      <div class="card">
        <div class="card-head"><h2>Historique des dépenses</h2>
          <div class="filters">
            <select data-change="exp-cat" aria-label="Filtrer par catégorie"><option value="">Toutes les catégories</option>${d.categories.map((c) => `<option value="${c.id}" ${F.expCat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
            <select data-change="exp-kind" aria-label="Filtrer par type"><option value="">Fixes et variables</option><option value="fixe" ${F.expKind === 'fixe' ? 'selected' : ''}>Fixes</option><option value="variable" ${F.expKind === 'variable' ? 'selected' : ''}>Variables</option></select>
            <div class="seg small"><label><input type="radio" name="expall" data-change="expenses-all" value="0" ${F.expensesAll ? '' : 'checked'}><span>Ce mois</span></label><label><input type="radio" name="expall" data-change="expenses-all" value="1" ${F.expensesAll ? 'checked' : ''}><span>Tout</span></label></div>
          </div>
        </div>
        ${list.length ? txTable(list.map((e) => { const c = cat(e.categoryId); return { id: e.id, date: e.date, label: e.label || c.name, dot: c.color, recurring: !!e.recurringId,
          tagHtml: `<span class="tag">${esc(c.name)}</span> <span class="tag ${e.kind === 'fixe' ? 'fixed' : ''}">${e.kind === 'fixe' ? 'Fixe' : 'Variable'}</span>`, amount: e.amount }; }), 'expense', F.expensesAll) + `<p class="help right">Total affiché : <strong>${money(FC.sum(list, (e) => e.amount))}</strong></p>` : '<p class="empty">Aucune dépense pour cette période.</p>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>Dépenses récurrentes</h2><button class="btn" data-action="add-recurring">+ Dépense récurrente</button></div>
        <p class="muted">Loyer, abonnements, assurances… Elles sont ajoutées automatiquement chaque mois à leur date et comptées dans le budget dès le début du mois.</p>
        ${rec.length ? `<table class="tx"><thead><tr><th>Libellé</th><th>Catégorie</th><th>Jour</th><th class="num">Montant</th><th>Statut</th><th></th></tr></thead><tbody>
          ${rec.map((r) => `<tr class="${r.active ? '' : 'inactive'}"><td>${esc(r.label)}</td><td><span class="sw" style="background:${cat(r.categoryId).color}"></span>${esc(cat(r.categoryId).name)}</td><td>le ${r.day}</td><td class="num">${money(r.amount)}</td>
            <td><button class="btn small ghost" data-action="toggle-recurring" data-id="${r.id}">${r.active ? 'Active' : 'En pause'}</button></td>
            <td class="row-actions"><button class="icon-btn" data-action="edit-recurring" data-id="${r.id}" aria-label="Modifier">✎</button><button class="icon-btn" data-action="del-recurring" data-id="${r.id}" aria-label="Supprimer">🗑</button></td></tr>`).join('')}
          </tbody></table><p class="help right">Total mensuel des récurrentes actives : <strong>${money(FC.sum(rec.filter((r) => r.active), (r) => r.amount))}</strong></p>` : '<p class="empty">Aucune dépense récurrente.</p>'}
      </div>`;
  }
  function expenseForm(exp) {
    const e = exp || { date: defaultDateFor(S.month), categoryId: S.data.categories[0] && S.data.categories[0].id, kind: 'variable', label: '', amount: '' };
    openModal(exp ? 'Modifier la dépense' : 'Ajouter une dépense', fields([
      { name: 'amount', label: 'Montant', type: 'money', required: true },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'categoryId', label: 'Catégorie', type: 'select', options: catOptions() },
      { name: 'kind', label: 'Type de dépense', type: 'radio', options: [{ value: 'variable', label: 'Variable' }, { value: 'fixe', label: 'Fixe' }] },
      { name: 'label', label: 'Description', placeholder: 'ex. Courses, essence…', wide: true },
    ], e), (o, form) => {
      if (!requireFields(form, ['amount', 'date'])) return;
      const rec = { date: o.date, amount: FC.round2(num(o.amount)), categoryId: o.categoryId, kind: o.kind || 'variable', label: o.label.trim() };
      if (rec.amount <= 0) return toast('Le montant doit être positif.', 'warning');
      const before = FC.monthSummary(S.data, FC.monthOf(rec.date), today());
      if (exp) Object.assign(exp, rec); else S.data.expenses.push({ id: uid(), ...rec });
      save(); closeModal(); S.month = FC.monthOf(rec.date); render();
      toast(exp ? 'Dépense modifiée.' : 'Dépense enregistrée.', 'good');
      budgetToast(before, FC.monthSummary(S.data, S.month, today()), rec.categoryId);
    });
  }
  /* Après chaque dépense : budget restant + alerte si proche de la limite ou dépassé */
  function budgetToast(before, after, catId) {
    const c = after.byCategory.find((x) => x.id === catId);
    const parts = [];
    if (after.budget.global) parts.push(`Budget restant du mois : <strong>${money(after.budget.remaining)}</strong>`);
    if (c && c.budget) parts.push(`${esc(c.name)} : ${money(c.remaining)} restants`);
    const worst = [after.budget.status, c ? c.status : 'ok'];
    const level = worst.includes('over') ? 'critical' : worst.includes('warn') ? 'warning' : 'info';
    if (level !== 'info') {
      const which = (c && c.status !== 'ok' && c.status !== 'none') ? c : null;
      const msg = level === 'critical' ? '✕ Budget dépassé' : '⚠ Budget bientôt atteint';
      parts.unshift(`<strong>${msg}${which ? ' (' + esc(which.name) + ')' : ''}</strong>`);
    }
    if (parts.length) toast(parts.join('<br>'), level, level === 'info' ? 4000 : 7000);
  }
  function recurringForm(r) {
    const v = r || { label: '', amount: '', categoryId: 'logement', day: 1, startMonth: FC.monthOf(today()), endMonth: '', active: true };
    openModal(r ? 'Modifier la dépense récurrente' : 'Nouvelle dépense récurrente', fields([
      { name: 'label', label: 'Libellé', required: true, placeholder: 'ex. Loyer, Netflix, assurance auto' },
      { name: 'amount', label: 'Montant mensuel', type: 'money', required: true },
      { name: 'categoryId', label: 'Catégorie', type: 'select', options: catOptions() },
      { name: 'day', label: 'Jour du mois', type: 'number', min: 1, max: 31, required: true },
      { name: 'startMonth', label: 'À partir de', type: 'month', required: true },
      { name: 'endMonth', label: "Jusqu'à (facultatif)", type: 'month' },
    ], v), (o, form) => {
      if (!requireFields(form, ['label', 'amount', 'day', 'startMonth'])) return;
      const rec = { label: o.label.trim(), amount: FC.round2(num(o.amount)), categoryId: o.categoryId, day: Math.min(31, Math.max(1, parseInt(o.day, 10) || 1)), startMonth: o.startMonth, endMonth: o.endMonth || '' };
      if (rec.amount <= 0) return toast('Le montant doit être positif.', 'warning');
      if (r) {
        Object.assign(r, rec);
        // Met à jour les occurrences futures déjà générées ? On ne touche pas aux occurrences passées.
      } else S.data.recurring.push({ id: uid(), active: true, skipped: [], ...rec });
      const added = FC.applyRecurring(S.data, today(), uid);
      save(); closeModal(); render();
      toast((r ? 'Dépense récurrente modifiée.' : 'Dépense récurrente créée.') + (added ? ` ${added} occurrence(s) ajoutée(s).` : ''), 'good');
    });
  }

  /* ================= Budget (2.3) ================= */
  function viewBudget() {
    const d = S.data, m = S.month;
    const s = FC.monthSummary(d, m, today());
    const b = s.budget;
    const catTotal = FC.sum(Object.values(b.categories || {}));
    const salary = FC.monthlySalary(d);
    const st = STATUS[b.status];
    return `<div class="kpis">
        ${kpi('Budget global', b.global ? money(b.global) : '—', b.inherited && b.from ? `Repris de ${monthLabel(b.from).toLowerCase()}` : b.inherited ? 'Non défini' : 'Défini pour ce mois')}
        ${kpi('Dépensé', money(s.totalExpenses), b.global ? pct(b.pct) + ' du budget' : '')}
        ${kpi('Budget restant', b.global ? money(b.remaining) : '—', b.global ? `Après récurrentes à venir : ${money(b.remainingAfterPlanned)}` : '', b.global && b.remaining < 0 ? 'neg' : 'hero')}
        ${kpi('État', b.global ? badge(st) : '—', '')}
      </div>
      <div class="card">
        <h2>Budget réel vs prévu</h2>
        ${b.global ? `<div class="budget-row big">
          <div class="row"><strong>Budget global</strong><span>${money(s.totalExpenses)} / ${money(b.global)}</span></div>
          ${progress(b.pct, b.status)}${s.pendingTotal ? `<div class="row small muted"><span>+ ${money(s.pendingTotal)} de dépenses récurrentes prévues</span></div>` : ''}</div>` : ''}
        ${s.byCategory.map((c) => budgetRow(c)).join('')}
        ${s.byCategory.some((c) => c.budget || c.spent) ? groupedBars(s.byCategory.filter((c) => c.budget || c.spent).map((c) => ({ label: c.name.length > 11 ? c.name.slice(0, 10) + '…' : c.name, tipLabel: c.name, values: [c.budget, c.spent] })),
          [{ name: 'Budget prévu', color: FC.PALETTE[0] }, { name: 'Dépenses réelles', color: FC.PALETTE[1] }], { aria: 'Budget prévu et dépenses réelles par catégorie' }) : ''}
      </div>
      <form class="card" data-form="budget" novalidate>
        <div class="card-head"><h2>Définir le budget de ${monthLabel(m).toLowerCase()}</h2></div>
        ${b.inherited && b.from ? `<p class="muted">Aucun budget spécifique pour ce mois : celui de ${monthLabel(b.from).toLowerCase()} s'applique. Enregistrez pour le personnaliser.</p>` : ''}
        ${fields([{ name: 'global', label: 'Budget mensuel global', type: 'money', required: true, help: salary ? `Votre salaire mensuel : ${money(salary)}` : '' }], { global: b.global || '' })}
        <h3>Budget par catégorie</h3>
        <div class="grid-form">${d.categories.map((c) => field({ name: 'cat_' + c.id, label: c.name, type: 'money' }, (b.categories || {})[c.id] || '')).join('')}</div>
        <p class="help">Somme des budgets par catégorie : <strong>${money(catTotal)}</strong>${b.global && catTotal > b.global ? ` <span class="badge warning">⚠ supérieure au budget global</span>` : ''}</p>
        <div class="actions"><button class="btn ghost" type="button" data-action="copy-budget-next">Copier vers le mois suivant</button><button class="btn primary" type="submit">Enregistrer le budget</button></div>
      </form>`;
  }

  /* ================= Épargne (2.4 & 2.5) ================= */
  function viewSavings() {
    const d = S.data, t = today();
    const a = FC.salaryAllocation(d, FC.monthOf(t));
    const goals = d.goals.filter((g) => !g.archived);
    const rec = FC.recommendedPercents(d, t);
    const sal = d.profile.salary;
    return `<div class="card">
        <div class="card-head"><h2>Calcul de l'épargne par salaire</h2><button class="btn ghost small" data-action="edit-salary">Modifier le salaire</button></div>
        <p class="muted">Salaire : <strong>${money(sal.amount || 0)}</strong> · ${FC.FREQUENCIES[sal.frequency].label.toLowerCase()} → <strong>${money(a.salary)}</strong> par mois.</p>
        ${a.salary ? `<form data-form="percents" novalidate>
          <table class="tx alloc"><thead><tr><th>Objectif</th><th>% du salaire</th><th class="num">Par salaire</th><th class="num">Par mois</th><th class="num">Recommandé</th></tr></thead><tbody>
          ${goals.map((g) => { const p = a.perGoal.find((x) => x.id === g.id); return `<tr><td>${esc(g.name)}</td>
            <td><div class="pct-input"><input type="number" name="p_${g.id}" min="0" max="100" step="0.1" value="${Number(g.percent) || 0}" data-change="pct-live"><span>%</span></div></td>
            <td class="num" data-per-salary="${g.id}">${money(p.perSalary)}</td><td class="num" data-per-month="${g.id}">${money(p.monthly)}</td>
            <td class="num">${rec[g.id] !== undefined && g.deadline ? pct(rec[g.id], 1) : '<span class="muted">—</span>'}</td></tr>`; }).join('')}
          </tbody></table>
          ${goals.length ? '' : '<p class="empty">Créez un objectif pour lui attribuer un pourcentage.</p>'}
          <div id="alloc-summary">${allocationTable(a)}</div>
          ${goals.length ? `<div class="actions"><button class="btn ghost" type="button" data-action="auto-percents" title="Calcule le pourcentage nécessaire pour atteindre chaque objectif à sa date limite">Ajuster automatiquement</button><button class="btn primary" type="submit">Enregistrer les pourcentages</button></div>` : ''}
        </form>` : '<p class="empty">Renseignez votre salaire pour calculer automatiquement l\'épargne.</p>'}
      </div>
      <div class="card-head page-head"><h2>Objectifs d'épargne</h2><button class="btn primary" data-action="add-goal">+ Nouvel objectif</button></div>
      <div class="goals">${goals.length ? goals.map((g) => goalCard(g, t)).join('') : '<div class="card"><p class="empty">Aucun objectif d\'épargne. Créez-en un : vacances, voiture, achat immobilier, fonds d\'urgence…</p></div>'}</div>`;
  }
  function allocationTable(a) {
    if (!a.salary) return '<p class="empty">Aucun salaire renseigné.</p>';
    const perSal = (v) => money(v / FC.perMonth(a.frequency));
    return `<table class="mini alloc-sum">
      <thead><tr><th></th><th class="num">%</th><th class="num">Par salaire</th><th class="num">Par mois</th></tr></thead>
      <tr><td><span class="sw" style="background:${FC.PALETTE[0]}"></span>Dépenses (budget)</td><td class="num">${pct(a.expensesPercent, 1)}</td><td class="num">${perSal(a.expenses)}</td><td class="num">${money(a.expenses)}</td></tr>
      <tr><td><span class="sw" style="background:${FC.PALETTE[1]}"></span>Épargne (objectifs)</td><td class="num">${pct(a.savingsPercent, 1)}</td><td class="num">${perSal(a.savings)}</td><td class="num">${money(a.savings)}</td></tr>
      <tr class="${a.overAllocated ? 'neg' : ''}"><td><span class="sw" style="background:${FC.PALETTE[2]}"></span>Argent disponible</td><td class="num">${pct(a.availablePercent, 1)}</td><td class="num">${perSal(a.available)}</td><td class="num">${money(a.available)}</td></tr>
      <tr class="total"><td>Salaire</td><td class="num">100 %</td><td class="num">${perSal(a.salary)}</td><td class="num">${money(a.salary)}</td></tr>
    </table>${a.overAllocated ? `<div class="alert critical"><span aria-hidden="true">✕</span><strong>Attention</strong> Le budget et l'épargne dépassent votre salaire de ${money(-a.available)}. Réduisez un pourcentage ou votre budget.</div>` : ''}`;
  }
  function goalCard(g, t) {
    const st = FC.goalStats(g, t, S.data);
    const contribs = [...(g.contributions || [])].sort((x, y) => y.date.localeCompare(x.date));
    return `<div class="card goal">
      <div class="row"><div><h3>${esc(g.name)}</h3><span class="tag">${esc(GOAL_TYPES[g.type] || 'Autre')}</span>${g.deadline ? ` <span class="muted small">avant le ${dateFr(g.deadline)}</span>` : ''}</div>${badge(GOAL_STATUS[st.status])}</div>
      <div class="goal-amount"><strong>${money(st.saved)}</strong> <span class="muted">sur ${money(st.target)}</span><span class="goal-pct">${pct(st.pct, 1)}</span></div>
      ${progress(st.pct, st.status === 'retard' || st.status === 'depasse' ? 'warn' : 'goal')}
      <dl class="stats">
        <div><dt>Reste à épargner</dt><dd>${money(st.remaining)}</dd></div>
        <div><dt>Par mois nécessaire</dt><dd>${st.monthlyNeeded === null ? '—' : money(st.monthlyNeeded)}</dd></div>
        <div><dt>Par salaire nécessaire</dt><dd>${st.perSalaryNeeded === null ? '—' : money(st.perSalaryNeeded)}</dd></div>
        <div><dt>% du salaire conseillé</dt><dd>${st.recommendedPercent === null ? '—' : pct(st.recommendedPercent, 1)}</dd></div>
        <div><dt>% du salaire actuel</dt><dd>${pct(Number(g.percent) || 0, 1)} <small class="muted">(${money(st.plannedPerSalary)}/salaire)</small></dd></div>
        <div><dt>Temps restant</dt><dd>${st.daysLeft === null ? '—' : st.daysLeft < 0 ? 'Échu' : st.monthsLeft >= 1 ? Math.round(st.monthsLeft * 10) / 10 + ' mois' : st.daysLeft + ' jours'}</dd></div>
      </dl>
      <div class="actions left">
        <button class="btn primary small" data-action="add-contrib" data-id="${g.id}">+ Versement</button>
        <button class="btn small" data-action="withdraw" data-id="${g.id}">Retrait</button>
        <button class="btn ghost small" data-action="edit-goal" data-id="${g.id}">Modifier</button>
        <button class="btn ghost small danger" data-action="del-goal" data-id="${g.id}">Supprimer</button>
      </div>
      ${contribs.length ? `<details><summary>Historique des versements (${contribs.length})</summary><ul class="contribs">${contribs.map((c) => `<li><span>${dateFr(c.date)} · ${esc(c.note || '')}</span><span class="${c.amount < 0 ? 'neg' : ''}">${money(c.amount)}</span><button class="icon-btn" data-action="del-contrib" data-id="${g.id}" data-cid="${c.id}" aria-label="Supprimer le versement">✕</button></li>`).join('')}</ul></details>` : ''}
    </div>`;
  }
  function goalForm(g) {
    const v = g || { name: '', type: 'vacances', target: '', deadline: '', initial: '', percent: '' };
    openModal(g ? "Modifier l'objectif" : "Nouvel objectif d'épargne", fields([
      { name: 'name', label: "Nom de l'objectif", required: true, placeholder: 'ex. Vacances au Portugal' },
      { name: 'type', label: 'Projet', type: 'select', options: Object.entries(GOAL_TYPES).map(([value, label]) => ({ value, label })) },
      { name: 'target', label: 'Montant cible', type: 'money', required: true },
      { name: 'deadline', label: 'Date limite', type: 'date', min: today() },
      ...(g ? [] : [{ name: 'initial', label: 'Montant déjà épargné', type: 'money' }]),
      { name: 'percent', label: '% du salaire à y consacrer', type: 'number', min: 0, max: 100, step: 0.1, help: 'Laissez vide pour utiliser le pourcentage recommandé.' },
    ], v), (o, form) => {
      if (!requireFields(form, ['name', 'target'])) return;
      const rec = { name: o.name.trim(), type: o.type, target: FC.round2(num(o.target)), deadline: o.deadline || '' };
      if (rec.target <= 0) return toast('Le montant cible doit être positif.', 'warning');
      let goal = g;
      if (g) Object.assign(g, rec);
      else {
        goal = { id: uid(), createdAt: today(), contributions: [], percent: 0, ...rec };
        S.data.goals.push(goal);
        if (num(o.initial) > 0) addContribution(goal.id, FC.round2(num(o.initial)), today(), 'Épargne initiale');
      }
      if (String(o.percent).trim() !== '') goal.percent = Math.max(0, Math.min(100, num(o.percent)));
      else if (!g) { const st = FC.goalStats(goal, today(), S.data); goal.percent = st.recommendedPercent !== null ? Math.ceil(st.recommendedPercent * 10) / 10 : 0; }
      save(); closeModal(); render();
      toast(g ? 'Objectif modifié.' : `Objectif créé : ${pct(goal.percent, 1)} de votre salaire y sera consacré.`, 'good');
    });
  }
  function addContribution(goalId, amount, date, note) {
    const g = S.data.goals.find((x) => x.id === goalId);
    if (!g) return;
    const wasReached = FC.goalSaved(g) >= g.target;
    g.contributions = g.contributions || [];
    g.contributions.push({ id: uid(), date, amount: FC.round2(amount), note: note || '' });
    if (!wasReached && FC.goalSaved(g) >= g.target) setTimeout(() => toast(`★ Bravo ! Objectif « ${esc(g.name)} » atteint.`, 'good', 6000), 200);
  }
  function contribForm(g, withdraw) {
    const st = FC.goalStats(g, today(), S.data);
    openModal(withdraw ? `Retrait — ${g.name}` : `Versement — ${g.name}`, fields([
      { name: 'amount', label: 'Montant', type: 'money', required: true, help: withdraw ? `Disponible : ${money(st.saved)}` : `Suggestion : ${st.perSalaryNeeded ? money(st.perSalaryNeeded) + ' par salaire' : '—'}` },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'note', label: 'Note' },
    ], { date: today(), amount: !withdraw && st.plannedPerSalary ? st.plannedPerSalary : '' }), (o, form) => {
      if (!requireFields(form, ['amount', 'date'])) return;
      let amt = FC.round2(num(o.amount));
      if (amt <= 0) return toast('Le montant doit être positif.', 'warning');
      if (withdraw) { if (amt > st.saved) return toast('Le retrait dépasse le montant épargné.', 'warning'); amt = -amt; }
      addContribution(g.id, amt, o.date, o.note.trim() || (withdraw ? 'Retrait' : 'Versement'));
      save(); closeModal(); render();
      toast(withdraw ? 'Retrait enregistré.' : 'Versement enregistré.', 'good');
    });
  }
  function salaryForm() {
    const s = S.data.profile.salary;
    openModal('Salaire', fields([
      { name: 'amount', label: 'Salaire net par versement', type: 'money', required: true },
      { name: 'frequency', label: 'Fréquence de versement', type: 'select', options: freqOptions() },
      { name: 'day', label: 'Jour de versement', type: 'number', min: 1, max: 31 },
    ], s), (o, form) => {
      if (!requireFields(form, ['amount'])) return;
      S.data.profile.salary = { amount: FC.round2(num(o.amount)), frequency: o.frequency, day: Math.min(31, Math.max(1, parseInt(o.day, 10) || 1)) };
      save(); closeModal(); render(); toast('Salaire mis à jour : les montants d\'épargne ont été recalculés.', 'good');
    });
  }

  /* ================= Historique, comparaison et bilan (3.2, §4 étape 8) ================= */
  function viewHistory() {
    const d = S.data, t = today(), m = S.month;
    const months = FC.monthRange(FC.addMonths(m, -11), m);
    const h = FC.history(d, months, t);
    const firstActive = h.findIndex((r) => r.income || r.expenses || r.savings);
    const shown = firstActive < 0 ? h.slice(-6) : h.slice(Math.min(firstActive, h.length - 3));
    const cmpA = S.filters.cmpA || FC.addMonths(m, -1), cmpB = S.filters.cmpB || m;
    const cmp = FC.compareMonths(d, cmpA, cmpB, t);
    const s = FC.monthSummary(d, m, t);
    const prev = FC.monthSummary(d, FC.addMonths(m, -1), t);
    const goals = d.goals.filter((g) => !g.archived);
    const monthOpts = (sel) => FC.monthRange(FC.addMonths(FC.monthOf(t), -23), FC.addMonths(FC.monthOf(t), 1)).reverse().map((x) => `<option value="${x}" ${x === sel ? 'selected' : ''}>${monthLabel(x)}</option>`).join('');
    const deltaCell = (x, inverse) => {
      if (!x.diff) return '<span class="muted">=</span>';
      const good = inverse ? x.diff < 0 : x.diff > 0;
      return `<span class="delta ${good ? 'up' : 'down'}">${x.diff > 0 ? '▲ +' : '▼ '}${money(x.diff)}${x.pct !== null ? ` (${x.diff > 0 ? '+' : ''}${pct(x.pct)})` : ''}</span>`;
    };
    return `<div class="card">
        <h2>Bilan de ${monthLabel(m).toLowerCase()}</h2>
        <div class="kpis inner">
          ${kpi('Revenus', money(s.totalIncome), prev.totalIncome ? 'Mois précédent : ' + money(prev.totalIncome) : '')}
          ${kpi('Dépenses', money(s.totalExpenses), prev.totalExpenses ? 'Mois précédent : ' + money(prev.totalExpenses) : '')}
          ${kpi('Épargne', money(s.savings), prev.savings ? 'Mois précédent : ' + money(prev.savings) : '')}
          ${kpi('Solde', money(s.balance), s.budget.global ? (s.budget.remaining >= 0 ? `Budget respecté (${money(s.budget.remaining)} non dépensés)` : `Budget dépassé de ${money(-s.budget.remaining)}`) : '', s.balance < 0 ? 'neg' : 'hero')}
        </div>
        <ul class="summary-list">
          ${s.byCategory.filter((c) => c.status === 'over').map((c) => `<li>${badge(STATUS.over)} ${esc(c.name)} : ${money(c.spent)} pour un budget de ${money(c.budget)}.</li>`).join('')}
          ${goals.map((g) => { const st = FC.goalStats(g, t, d); return `<li>${esc(g.name)} : ${pct(st.pct)} atteint, ${money(st.remaining)} restants. ${badge(GOAL_STATUS[st.status])}</li>`; }).join('')}
        </ul>
        <div class="actions left"><button class="btn primary" data-action="prepare-next">Préparer le budget de ${monthLabel(FC.addMonths(m, 1)).toLowerCase()}</button></div>
      </div>
      <div class="card">
        <h2>Évolution mois par mois</h2>
        ${groupedBars(shown.map((r) => ({ label: shortMonth(r.month), tipLabel: monthLabel(r.month), values: [r.income, r.expenses, r.savings] })),
          [{ name: 'Revenus', color: FC.PALETTE[0] }, { name: 'Dépenses', color: FC.PALETTE[1] }, { name: 'Épargne', color: FC.PALETTE[2] }], { aria: 'Revenus, dépenses et épargne par mois' })}
        <table class="tx"><thead><tr><th>Mois</th><th class="num">Revenus</th><th class="num">Dépenses</th><th class="num">Épargne</th><th class="num">Solde</th><th class="num">Budget</th></tr></thead><tbody>
          ${[...shown].reverse().map((r) => `<tr><td><a href="#historique" data-action="goto-month" data-month="${r.month}">${monthLabel(r.month)}</a></td><td class="num">${money(r.income)}</td><td class="num">${money(r.expenses)}</td><td class="num">${money(r.savings)}</td><td class="num ${r.balance < 0 ? 'neg' : ''}">${money(r.balance)}</td><td class="num">${r.budget ? money(r.budget) : '—'}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <div class="card-head"><h2>Comparer deux mois</h2>
          <div class="filters"><select data-change="cmp-a" aria-label="Premier mois">${monthOpts(cmpA)}</select><span>→</span><select data-change="cmp-b" aria-label="Second mois">${monthOpts(cmpB)}</select></div>
        </div>
        <table class="tx"><thead><tr><th></th><th class="num">${monthLabel(cmpA)}</th><th class="num">${monthLabel(cmpB)}</th><th class="num">Évolution</th></tr></thead><tbody>
          <tr><td>Revenus</td><td class="num">${money(cmp.income.a)}</td><td class="num">${money(cmp.income.b)}</td><td class="num">${deltaCell(cmp.income)}</td></tr>
          <tr><td>Dépenses</td><td class="num">${money(cmp.expenses.a)}</td><td class="num">${money(cmp.expenses.b)}</td><td class="num">${deltaCell(cmp.expenses, true)}</td></tr>
          <tr><td>Épargne</td><td class="num">${money(cmp.savings.a)}</td><td class="num">${money(cmp.savings.b)}</td><td class="num">${deltaCell(cmp.savings)}</td></tr>
          <tr class="total"><td>Solde</td><td class="num">${money(cmp.balance.a)}</td><td class="num">${money(cmp.balance.b)}</td><td class="num">${deltaCell(cmp.balance)}</td></tr>
          ${cmp.categories.length ? `<tr class="group"><td colspan="4">Dépenses par catégorie</td></tr>` + cmp.categories.map((c) => `<tr><td><span class="sw" style="background:${c.color}"></span>${esc(c.name)}</td><td class="num">${money(c.a)}</td><td class="num">${money(c.b)}</td><td class="num">${deltaCell(c, true)}</td></tr>`).join('') : ''}
        </tbody></table>
      </div>`;
  }
  function prepareNextBudget() {
    const m = S.month, next = FC.addMonths(m, 1);
    const s = FC.monthSummary(S.data, m, today());
    const b = FC.budgetFor(S.data, next);
    const recurringByCat = {};
    for (const r of S.data.recurring.filter((x) => x.active)) recurringByCat[r.categoryId] = (recurringByCat[r.categoryId] || 0) + r.amount;
    openModal(`Budget de ${monthLabel(next).toLowerCase()}`,
      `<p class="muted">Pré-rempli avec le budget actuel. Entre parenthèses : dépenses réelles de ${monthLabel(m).toLowerCase()}${Object.keys(recurringByCat).length ? ' et récurrentes déjà prévues' : ''}.</p>
      ${fields([{ name: 'global', label: `Budget global (dépensé : ${money(s.totalExpenses)})`, type: 'money', required: true }], { global: b.global || FC.round2(s.totalExpenses) || '' })}
      <div class="grid-form">${S.data.categories.map((c) => { const sp = (s.byCategory.find((x) => x.id === c.id) || {}).spent || 0; const rc = recurringByCat[c.id] || 0;
        return field({ name: 'cat_' + c.id, label: `${c.name} (${money(sp)}${rc ? ' · réc. ' + money(rc) : ''})`, type: 'money' }, (b.categories || {})[c.id] || ''); }).join('')}</div>`,
      (o, form) => {
        if (!requireFields(form, ['global'])) return;
        saveBudgetFrom(o, next); closeModal(); S.month = next; S.route = 'budget'; location.hash = 'budget'; render();
        toast(`Budget de ${monthLabel(next).toLowerCase()} enregistré.`, 'good');
      });
  }

  /* ================= Paramètres ================= */
  function viewSettings() {
    const d = S.data;
    return `<form class="card" data-form="profile" novalidate>
        <h2>Profil</h2>
        ${fields([
          { name: 'name', label: 'Prénom', required: true },
          { name: 'currency', label: 'Devise', type: 'select', options: [['EUR', 'Euro (€)'], ['CHF', 'Franc suisse (CHF)'], ['CAD', 'Dollar canadien ($ CA)'], ['USD', 'Dollar américain ($)'], ['XOF', 'Franc CFA (XOF)'], ['MAD', 'Dirham marocain (MAD)'], ['GBP', 'Livre sterling (£)']].map(([value, label]) => ({ value, label })) },
          { name: 'amount', label: 'Salaire net par versement', type: 'money', required: true },
          { name: 'frequency', label: 'Fréquence de versement', type: 'select', options: freqOptions() },
          { name: 'day', label: 'Jour de versement', type: 'number', min: 1, max: 31 },
        ], { name: d.profile.name, currency: d.profile.currency, ...d.profile.salary })}
        <div class="actions"><button class="btn primary" type="submit">Enregistrer</button></div>
      </form>
      <div class="card">
        <div class="card-head"><h2>Catégories de dépenses</h2><button class="btn" data-action="add-category">+ Catégorie</button></div>
        <ul class="cat-list">${d.categories.map((c) => `<li><span class="sw big" style="background:${c.color}"></span><span>${esc(c.name)}</span><span class="muted small">${d.expenses.filter((e) => e.categoryId === c.id).length} dépense(s)</span>
          <span class="row-actions"><button class="icon-btn" data-action="edit-category" data-id="${c.id}" aria-label="Modifier">✎</button><button class="icon-btn" data-action="del-category" data-id="${c.id}" aria-label="Supprimer">🗑</button></span></li>`).join('')}</ul>
      </div>
      <div class="card">
        <h2>Compte</h2>
        <p class="muted">Connecté en tant que <strong>${esc(S.user)}</strong>. ${Backend.settingsNote ? Backend.settingsNote(esc(S.user)) : Backend.online ? 'Les données sont enregistrées dans des fichiers CSV, dans le dossier <code>donnees/utilisateurs/' + esc(S.user) + '/</code> de Finance_Care. Elles sont rechargées à chaque lancement.' : 'Mode navigateur : les données sont enregistrées dans ce navigateur. Lancez Finance_Care avec le serveur pour les enregistrer en CSV.'}</p>
        <div class="actions left"><button class="btn" data-action="restart-onboarding">Relancer la configuration guidée</button><button class="btn" data-action="load-demo">Charger des données d'exemple</button><button class="btn ghost danger" data-action="reset-data">Effacer toutes mes données</button></div>
      </div>`;
  }
  function categoryForm(c) {
    const used = new Set(S.data.categories.map((x) => x.color));
    const nextColor = FC.PALETTE.find((p) => !used.has(p)) || '#8d8d8d';
    openModal(c ? 'Modifier la catégorie' : 'Nouvelle catégorie', fields([
      { name: 'name', label: 'Nom', required: true },
      { name: 'color', label: 'Couleur', type: 'color' },
    ], c || { name: '', color: nextColor }), (o, form) => {
      if (!requireFields(form, ['name'])) return;
      if (c) { c.name = o.name.trim(); c.color = o.color; }
      else {
        let id = o.name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-') || uid();
        if (S.data.categories.some((x) => x.id === id)) id += '-' + uid().slice(-4);
        S.data.categories.push({ id, name: o.name.trim(), color: o.color });
      }
      save(); closeModal(); render();
    });
  }

  /* ================= Données d'exemple ================= */
  function loadDemo() {
    const d = S.data, t = today(), cur = FC.monthOf(t);
    d.profile.salary = { amount: 2400, frequency: 'mensuel', day: 1 };
    d.incomes = []; d.expenses = []; d.recurring = []; d.goals = []; d.budgets = {};
    const start = FC.addMonths(cur, -4);
    d.budgets[start] = { global: 1700, categories: { alimentation: 400, logement: 750, transport: 150, loisirs: 150, sante: 60, abonnements: 40, assurances: 60, autres: 90 } };
    d.recurring.push({ id: uid(), label: 'Loyer', amount: 750, categoryId: 'logement', day: 5, startMonth: start, endMonth: '', active: true, skipped: [] });
    d.recurring.push({ id: uid(), label: 'Abonnement streaming + téléphone', amount: 32.99, categoryId: 'abonnements', day: 12, startMonth: start, endMonth: '', active: true, skipped: [] });
    d.recurring.push({ id: uid(), label: 'Assurance habitation', amount: 18.5, categoryId: 'assurances', day: 20, startMonth: start, endMonth: '', active: true, skipped: [] });
    let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const goalV = { id: uid(), name: 'Vacances d\'été', type: 'vacances', target: 1500, deadline: FC.addMonths(cur, 7) + '-01', createdAt: start + '-01', percent: 8, contributions: [] };
    const goalU = { id: uid(), name: "Fonds d'urgence", type: 'urgence', target: 5000, deadline: FC.addMonths(cur, 20) + '-01', createdAt: start + '-01', percent: 7, contributions: [{ id: uid(), date: start + '-01', amount: 1200, note: 'Épargne initiale' }] };
    d.goals.push(goalV, goalU);
    for (const m of FC.monthRange(start, cur)) {
      const last = m === cur ? Number(t.slice(8, 10)) : FC.daysInMonth(m);
      d.incomes.push({ id: uid(), date: m + '-01', amount: 2400, type: 'salaire', label: 'Salaire' });
      if (rnd() > 0.5 && last > 15) d.incomes.push({ id: uid(), date: m + '-15', amount: Math.round(100 + rnd() * 250), type: 'supplementaire', label: 'Mission freelance' });
      goalV.contributions.push({ id: uid(), date: m + '-01', amount: 192, note: 'Épargne sur salaire' });
      goalU.contributions.push({ id: uid(), date: m + '-01', amount: 168, note: 'Épargne sur salaire' });
      const add = (day, amount, categoryId, label) => { if (day <= last) d.expenses.push({ id: uid(), date: m + '-' + String(day).padStart(2, '0'), amount: FC.round2(amount), categoryId, kind: 'variable', label }); };
      for (let w = 0; w < 4; w++) add(3 + w * 7, 70 + rnd() * 45, 'alimentation', 'Courses');
      add(8, 40 + rnd() * 30, 'transport', 'Carburant'); add(22, 35 + rnd() * 40, 'transport', 'Carburant');
      add(10, 25 + rnd() * 60, 'loisirs', 'Cinéma / sorties'); add(24, 30 + rnd() * 90, 'loisirs', 'Restaurant');
      if (rnd() > 0.4) add(16, 25 + rnd() * 40, 'sante', 'Pharmacie');
      add(27, 20 + rnd() * 50, 'autres', 'Divers');
    }
    FC.applyRecurring(d, t, uid);
    d.onboarded = true; save(); S.month = cur; location.hash = 'tableau'; S.route = 'tableau'; render();
    toast("Données d'exemple chargées.", 'good');
  }

  /* ================= Actions ================= */
  const find = (arr, id) => arr.find((x) => x.id === id);
  const actions = {
    'auth-mode': (ds) => renderAuth(ds.mode),
    logout,
    'close-modal': closeModal,
    month: (ds) => { S.month = FC.addMonths(S.month, Number(ds.delta)); render(); },
    'month-today': () => { S.month = FC.monthOf(today()); render(); },
    'goto-month': (ds, el, e) => { e.preventDefault(); S.month = ds.month; render(); window.scrollTo(0, 0); },
    'add-income': () => incomeForm(),
    'edit-income': (ds) => incomeForm(find(S.data.incomes, ds.id)),
    'del-income': (ds) => confirmModal('Supprimer ce revenu ?', () => { S.data.incomes = S.data.incomes.filter((i) => i.id !== ds.id); }),
    'add-expense': () => expenseForm(),
    'edit-expense': (ds) => expenseForm(find(S.data.expenses, ds.id)),
    'del-expense': (ds) => confirmModal('Supprimer cette dépense ?', () => {
      const e = find(S.data.expenses, ds.id);
      if (e && e.recurringId) { const r = find(S.data.recurring, e.recurringId); if (r) { r.skipped = r.skipped || []; r.skipped.push(FC.monthOf(e.date)); } }
      S.data.expenses = S.data.expenses.filter((x) => x.id !== ds.id);
    }),
    'add-recurring': () => recurringForm(),
    'edit-recurring': (ds) => recurringForm(find(S.data.recurring, ds.id)),
    'toggle-recurring': (ds) => { const r = find(S.data.recurring, ds.id); r.active = !r.active; if (r.active) FC.applyRecurring(S.data, today(), uid); save(); render(); },
    'del-recurring': (ds) => confirmModal('Supprimer cette dépense récurrente ? Les dépenses déjà enregistrées sont conservées.', () => {
      S.data.recurring = S.data.recurring.filter((r) => r.id !== ds.id);
      S.data.expenses.forEach((e) => { if (e.recurringId === ds.id) delete e.recurringId; });
    }),
    'copy-budget-next': () => {
      const form = document.querySelector('form[data-form="budget"]');
      const next = FC.addMonths(S.month, 1);
      saveBudgetFrom(formObj(form), next); toast(`Budget copié vers ${monthLabel(next).toLowerCase()}.`, 'good');
    },
    'prepare-next': prepareNextBudget,
    'add-goal': () => goalForm(),
    'edit-goal': (ds) => goalForm(find(S.data.goals, ds.id)),
    'del-goal': (ds) => confirmModal('Supprimer cet objectif et son historique de versements ?', () => { S.data.goals = S.data.goals.filter((g) => g.id !== ds.id); }),
    'add-contrib': (ds) => contribForm(find(S.data.goals, ds.id), false),
    withdraw: (ds) => contribForm(find(S.data.goals, ds.id), true),
    'del-contrib': (ds) => confirmModal('Supprimer ce versement ?', () => { const g = find(S.data.goals, ds.id); g.contributions = g.contributions.filter((c) => c.id !== ds.cid); }),
    'auto-percents': () => {
      const rec = FC.recommendedPercents(S.data, today());
      const form = document.querySelector('form[data-form="percents"]');
      for (const [id, p] of Object.entries(rec)) { const g = find(S.data.goals, id); if (g && g.deadline && form.elements['p_' + id]) form.elements['p_' + id].value = p; }
      livePercents(); toast('Pourcentages ajustés pour atteindre chaque objectif à sa date limite. Pensez à enregistrer.', 'info');
    },
    'edit-salary': salaryForm,
    'add-category': () => categoryForm(),
    'edit-category': (ds) => categoryForm(find(S.data.categories, ds.id)),
    'del-category': (ds) => confirmModal('Supprimer cette catégorie ? Ses dépenses seront déplacées vers « Autres » (créée si besoin).', () => {
      let other = S.data.categories.find((c) => c.id === 'autres' && c.id !== ds.id);
      if (!other) { other = { id: 'autres-' + uid().slice(-4), name: 'Autres', color: '#8d8d8d' }; S.data.categories.push(other); }
      S.data.categories = S.data.categories.filter((c) => c.id !== ds.id);
      S.data.expenses.forEach((e) => { if (e.categoryId === ds.id) e.categoryId = other.id; });
      S.data.recurring.forEach((r) => { if (r.categoryId === ds.id) r.categoryId = other.id; });
      Object.values(S.data.budgets).forEach((b) => { if (b.categories) delete b.categories[ds.id]; });
    }),
    'restart-onboarding': () => { S.data.onboarded = false; S.onboardStep = 0; save(); render(); },
    'load-demo': () => confirmModal("Remplacer toutes vos données par des données d'exemple ?", loadDemo, true),
    'reset-data': () => confirmModal('Effacer définitivement toutes vos données financières ?', () => {
      const name = S.data.profile.name; S.data = newData(name); S.onboardStep = 0;
    }),
    'onb-step': (ds) => { S.onboardStep = Number(ds.step); render(); },
    'onb-goals-done': () => { S.onboardStep = 3; render(); },
    'onb-finish': () => { S.data.onboarded = true; save(); S.route = 'tableau'; location.hash = 'tableau'; render(); toast('Bienvenue dans Finance_Care !', 'good'); },
    'onb-skip': () => { S.data.onboarded = true; save(); S.route = 'tableau'; location.hash = 'tableau'; render(); },
  };
  function confirmModal(text, fn, raw) {
    openModal('Confirmation', `<p>${esc(text)}</p>`, () => { closeModal(); fn(); if (!raw) { save(); render(); } }, 'Confirmer');
  }
  function livePercents() {
    const form = document.querySelector('form[data-form="percents"]');
    if (!form) return;
    const o = formObj(form);
    const clone = JSON.parse(JSON.stringify(S.data));
    clone.goals.forEach((g) => { if (o['p_' + g.id] !== undefined) g.percent = num(o['p_' + g.id]); });
    const a = FC.salaryAllocation(clone, FC.monthOf(today()));
    a.perGoal.forEach((p) => {
      const ps = form.querySelector(`[data-per-salary="${p.id}"]`), pm = form.querySelector(`[data-per-month="${p.id}"]`);
      if (ps) ps.textContent = money(p.perSalary); if (pm) pm.textContent = money(p.monthly);
    });
    document.getElementById('alloc-summary').innerHTML = allocationTable(a);
  }

  const forms = {
    login: doLogin, register: doRegister,
    '__modal': (o, f) => modalSubmit && modalSubmit(o, f),
    'onb-profile': onbProfile, 'onb-budget': onbBudget,
    budget: (o, form) => { if (!requireFields(form, ['global'])) return; saveBudgetFrom(o, S.month); render(); toast(`Budget de ${monthLabel(S.month).toLowerCase()} enregistré.`, 'good'); },
    percents: (o) => {
      S.data.goals.forEach((g) => { if (o['p_' + g.id] !== undefined) g.percent = Math.max(0, Math.min(100, num(o['p_' + g.id]))); });
      save(); render(); toast('Pourcentages enregistrés.', 'good');
    },
    profile: (o, form) => {
      if (!requireFields(form, ['name', 'amount'])) return;
      S.data.profile.name = o.name.trim(); S.data.profile.currency = o.currency;
      S.data.profile.salary = { amount: FC.round2(num(o.amount)), frequency: o.frequency, day: Math.min(31, Math.max(1, parseInt(o.day, 10) || 1)) };
      save(); render(); toast('Profil enregistré.', 'good');
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault(); fn(el.dataset, el, e); }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const fn = forms[f.dataset.form];
    if (fn) Promise.resolve(fn(formObj(f), f)).catch((err) => { console.error(err); toast('Une erreur est survenue.', 'critical'); });
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const k = el.dataset.change, F = S.filters;
    if (k === 'incomes-all') F.incomesAll = el.value === '1';
    else if (k === 'expenses-all') F.expensesAll = el.value === '1';
    else if (k === 'exp-cat') F.expCat = el.value;
    else if (k === 'exp-kind') F.expKind = el.value;
    else if (k === 'cmp-a') F.cmpA = el.value;
    else if (k === 'cmp-b') F.cmpB = el.value;
    else if (k === 'pct-live') return livePercents();
    render();
  });
  document.addEventListener('input', (e) => { if (e.target.matches('[data-change="pct-live"]')) livePercents(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('modal-root').classList.contains('open')) closeModal(); });
  window.addEventListener('hashchange', () => {
    const r = location.hash.slice(1);
    if (S.user && S.data && S.data.onboarded && r && r !== S.route) { S.route = r; render(); window.scrollTo(0, 0); }
  });

  /* ================= Démarrage ================= */
  (async () => {
    await Backend.init();
    const u = Session.get();
    if (u) await Backend.loadUser(u);
    if (u && Store.get(dataKey(u))) await login(u, false); else renderAuth('login');
    if (!Backend.online) setTimeout(() => toast("Mode navigateur : lancez Finance_Care avec « lancer » pour enregistrer vos données dans des fichiers CSV.", 'warning', 9000), 400);
  })();

  // Mise à jour automatique (dépenses récurrentes) si l'application reste ouverte au changement de jour
  let lastDay = today();
  setInterval(() => {
    if (!S.user || today() === lastDay) return;
    lastDay = today();
    if (FC.applyRecurring(S.data, lastDay, uid)) { save(); render(); }
  }, 60000);
})();
