/* Finance_Care mobile — enregistrement des fichiers CSV dans OneDrive (Microsoft Graph).
 *
 * - Connexion au compte Microsoft (OAuth 2.0 « code + PKCE », sans mot de passe stocké).
 * - Permission demandée : Files.ReadWrite.AppFolder = accès UNIQUEMENT au dossier de l'application
 *   (OneDrive > Applications > <nom de l'application>), jamais au reste du OneDrive.
 * - Les fichiers sont ceux de la version PC (comptes.csv, utilisateurs/<nom>/*.csv), au même format.
 * - Hors ligne : tout est gardé sur le téléphone et envoyé au retour du réseau.
 * - Conflits : si un fichier a changé sur OneDrive (ex. modifié depuis le PC) depuis la dernière
 *   synchronisation, il n'est PAS écrasé : l'application demande quelle version garder.
 *
 * Remplace le « Backend » de app.js (même interface : online, cache, init, handles, loadUser, write, flushAll).
 */
(function (root) {
  'use strict';
  const CSV = root.FCCSV;
  const CFG = Object.assign({
    clientId: '',
    authority: 'https://login.microsoftonline.com/consumers',
    scopes: 'openid profile offline_access Files.ReadWrite.AppFolder',
    graph: 'https://graph.microsoft.com/v1.0/me/drive/special/approot',
  }, root.FC_CONFIG || {});

  const LS_AUTH = 'fcod_auth', LS_STATE = 'fcod_state', LS_PKCE = 'fcod_pkce';
  const ls = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage plein */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const stripBom = (t) => String(t).replace(/^﻿/, '');
  const redirectUri = () => new URL('./', location.href).href.split('#')[0].split('?')[0];
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fetchT(url, opt = {}, ms = 15000) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    return fetch(url, Object.assign({}, opt, ctl ? { signal: ctl.signal } : {})).finally(() => t && clearTimeout(t));
  }

  /* ================= Connexion Microsoft ================= */
  const b64url = (bytes) => btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomStr = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  function decodeJwt(t) {
    try {
      const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(p + '==='.slice((p.length + 3) % 4)))));
    } catch (e) { return {}; }
  }

  class AuthError extends Error {}

  const Auth = {
    get() { return ls.get(LS_AUTH); },
    signedIn() { const a = this.get(); return !!(a && a.refresh_token); },
    account() { const a = this.get(); return a ? a.account || {} : {}; },
    async login({ silent = false } = {}) {
      const verifier = randomStr(48);
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const state = randomStr(16);
      ls.set(LS_PKCE, { verifier, state, silent });
      const q = new URLSearchParams({
        client_id: CFG.clientId, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
        scope: CFG.scopes, code_challenge: challenge, code_challenge_method: 'S256', state,
      });
      const acc = this.account();
      if (silent) q.set('prompt', 'none');
      else if (!acc.username) q.set('prompt', 'select_account');
      if (acc.username) q.set('login_hint', acc.username);
      location.assign(CFG.authority + '/oauth2/v2.0/authorize?' + q.toString());
      return new Promise(() => {}); // la page quitte l'application
    },
    /* Retour de la page de connexion Microsoft : ?code=…&state=… (ou ?error=…) */
    async handleRedirect() {
      const url = new URL(location.href);
      const code = url.searchParams.get('code'), err = url.searchParams.get('error'), state = url.searchParams.get('state');
      if (!code && !err) return { done: false };
      const pkce = ls.get(LS_PKCE) || {};
      ls.del(LS_PKCE);
      history.replaceState(null, '', redirectUri() + url.hash);
      if (!pkce.state || state !== pkce.state) return { done: true, error: 'La réponse de connexion ne correspond pas à la demande. Réessayez.' };
      if (err) return { done: true, silent: pkce.silent, error: url.searchParams.get('error_description') || err, code: err };
      await this.token({ grant_type: 'authorization_code', code, code_verifier: pkce.verifier, redirect_uri: redirectUri() });
      return { done: true };
    },
    async token(params) {
      const body = new URLSearchParams(Object.assign({ client_id: CFG.clientId, scope: CFG.scopes }, params));
      const r = await fetchT(CFG.authority + '/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        if (j.error === 'invalid_grant' || j.error === 'interaction_required' || r.status === 400) throw new AuthError(j.error_description || j.error || 'Reconnexion nécessaire');
        throw new Error('Serveur de connexion injoignable (' + r.status + ')');
      }
      const old = this.get() || {};
      const claims = j.id_token ? decodeJwt(j.id_token) : null;
      ls.set(LS_AUTH, {
        access_token: j.access_token,
        expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
        refresh_token: j.refresh_token || old.refresh_token,
        account: claims ? { name: claims.name || '', username: claims.preferred_username || claims.email || '' } : old.account || {},
      });
    },
    async accessToken() {
      const a = this.get();
      if (!a) throw new AuthError('Non connecté');
      if (a.access_token && a.expires_at - Date.now() > 120000) return a.access_token;
      if (!a.refresh_token) throw new AuthError('Reconnexion nécessaire');
      await this.token({ grant_type: 'refresh_token', refresh_token: a.refresh_token });
      return this.get().access_token;
    },
    logout() { ls.del(LS_AUTH); ls.del(LS_PKCE); },
  };

  /* ================= OneDrive (Microsoft Graph) ================= */
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const Graph = {
    async call(url, opt = {}) {
      const tok = await Auth.accessToken();
      const headers = Object.assign({ Authorization: 'Bearer ' + tok }, opt.headers || {});
      return fetchT(url, Object.assign({}, opt, { headers }));
    },
    /* Contenu d'un dossier : { 'fichier.csv': { etag, url } } ; {} si le dossier n'existe pas */
    async list(folder) {
      const out = {};
      let url = CFG.graph + (folder ? ':/' + encPath(folder) + ':' : '') + '/children?$top=200';
      while (url) {
        const r = await this.call(url);
        if (r.status === 404) return out;
        if (!r.ok) throw new Error('OneDrive : lecture impossible (' + r.status + ')');
        const j = await r.json();
        for (const it of j.value || []) if (it.file) out[it.name] = { etag: it.eTag, url: it['@microsoft.graph.downloadUrl'], id: it.id };
        url = j['@odata.nextLink'] || null;
      }
      return out;
    },
    async download(info) {
      let r = info.url ? await fetchT(info.url) : null;
      if (!r || !r.ok) r = await this.call(CFG.graph.replace(/\/special\/approot$/, '') + '/items/' + info.id + '/content');
      if (!r.ok) throw new Error('OneDrive : téléchargement impossible (' + r.status + ')');
      return stripBom(await r.text());
    },
    /* Envoi d'un fichier. etag connu → n'écrase que si le fichier n'a pas changé entre-temps (sinon 412 = conflit). */
    async upload(path, text, etag) {
      const headers = { 'Content-Type': 'text/csv; charset=utf-8' };
      if (etag) headers['If-Match'] = etag;
      const r = await this.call(CFG.graph + ':/' + encPath(path) + ':/content', { method: 'PUT', headers, body: text });
      if (r.status === 412) return { conflict: true };
      if (!r.ok) throw new Error('OneDrive : enregistrement impossible (' + r.status + ')');
      const j = await r.json();
      return { etag: j.eTag };
    },
  };

  /* ================= Synchronisation ================= */
  /* État gardé sur le téléphone (localStorage) :
     files : dernière version connue de chaque fichier sur OneDrive { chemin: { etag, text } }
     data  : dernières données locales { fc_accounts: …, fc_data_<u>: … }
     dirty : clés modifiées sur le téléphone pas encore envoyées
     conflicts : clés en conflit (fichier changé sur OneDrive ET sur le téléphone) */
  function loadState() {
    const s = ls.get(LS_STATE) || {};
    return { files: s.files || {}, data: s.data || {}, dirty: s.dirty || {}, conflicts: s.conflicts || {}, lastSync: s.lastSync || null };
  }

  const keyFiles = (k, v) => {
    if (k === 'fc_accounts') return { 'comptes.csv': CSV.accountsToCSV(v) };
    const u = k.slice(8), f = CSV.dataToFiles(v), out = {};
    for (const [name, text] of Object.entries(f)) out['utilisateurs/' + u + '/' + name] = text;
    return out;
  };

  const Backend = {
    online: true, cache: {}, timers: {}, status: 'ok', message: '', listeners: [],
    state: loadState(),
    graph: Graph, auth: Auth,
    persist() { ls.set(LS_STATE, this.state); },
    handles(k) { return k === 'fc_accounts' || k.startsWith('fc_data_'); },
    setStatus(s, msg) { this.status = s; this.message = msg || ''; this.listeners.forEach((f) => f(s, msg)); },
    onStatus(f) { this.listeners.push(f); },

    /* ----- Démarrage ----- */
    async init() {
      if (!CFG.clientId) { UI.screen('config'); return new Promise(() => {}); }
      let res = { done: false };
      try { res = await Auth.handleRedirect(); } catch (e) { res = { done: true, error: e.message }; }
      if (!Auth.signedIn()) { UI.screen('login', res.error); return new Promise(() => {}); }
      UI.mountPill();
      for (const [k, v] of Object.entries(this.state.data)) this.cache[k] = v;
      if (res.error) this.setStatus('auth', 'Reconnexion à OneDrive nécessaire.');
      else await this.syncAll({ pull: ['fc_accounts'], silentRelogin: true });
      window.addEventListener('online', () => this.syncAll({ pull: this.openKeys() }));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.syncAll({ pull: this.openKeys(), reloadIfChanged: true }); });
      setInterval(() => { if (Object.keys(this.state.dirty).length) this.syncAll({}); }, 60000);
    },
    openKeys() { return Object.keys(this.cache); },
    async loadUser(u) {
      const k = 'fc_data_' + u;
      if (!(k in this.cache)) this.cache[k] = this.state.data[k] || null;
      await this.syncAll({ pull: [k] });
    },

    /* ----- Écriture (appelée par l'application à chaque modification) ----- */
    write(k, v) {
      this.cache[k] = v;
      this.state.data[k] = v;
      this.state.dirty[k] = true;
      this.persist(); // gardé sur le téléphone immédiatement, même hors ligne
      this.setStatus('pending', 'Modifications en attente d’envoi');
      clearTimeout(this.timers[k]);
      this.timers[k] = setTimeout(() => this.syncAll({}), 1500);
    },
    flushAll() { this.persist(); if (Object.keys(this.state.dirty).length) this.syncAll({}); },

    /* ----- Envoi puis récupération ----- */
    async syncAll({ pull = [], reloadIfChanged = false, silentRelogin = false } = {}) {
      if (this.running) { this.again = true; return this.running; }
      this.running = (async () => {
        await null; // laisse « this.running » être défini avant la suite
        try {
          if (typeof navigator !== 'undefined' && navigator.onLine === false) throw Object.assign(new Error('hors ligne'), { offline: true });
          await this.push();
          let changed = false;
          for (const k of pull) if (!this.state.dirty[k] && !this.state.conflicts[k]) changed = (await this.pull(k)) || changed;
          this.state.lastSync = new Date().toISOString();
          this.persist();
          const nConf = Object.keys(this.state.conflicts).length;
          if (nConf) this.setStatus('conflict', 'Conflit : des données ont changé sur OneDrive et sur ce téléphone.');
          else if (Object.keys(this.state.dirty).length) this.setStatus('pending', 'Modifications en attente d’envoi');
          else this.setStatus('ok', 'À jour avec OneDrive');
          if (changed && reloadIfChanged && !nConf) { UI.reload('Données mises à jour depuis OneDrive.'); }
        } catch (e) {
          this.persist();
          if (e instanceof AuthError) {
            if (silentRelogin && navigator.onLine !== false && !sessionStorage.getItem('fcod_silent')) {
              sessionStorage.setItem('fcod_silent', '1');
              return Auth.login({ silent: true });
            }
            this.setStatus('auth', 'Reconnexion à OneDrive nécessaire.');
          } else if (e.offline || e.name === 'AbortError' || e instanceof TypeError) this.setStatus('offline', 'Hors ligne : les modifications sont gardées sur ce téléphone.');
          else this.setStatus('error', e.message);
        } finally {
          this.running = null;
          if (this.again) { this.again = false; setTimeout(() => this.syncAll({}), 0); }
        }
      })();
      return this.running;
    },

    async push() {
      for (const k of Object.keys(this.state.dirty)) {
        if (this.state.conflicts[k]) continue;
        const v = this.state.data[k];
        if (v === null || v === undefined) { delete this.state.dirty[k]; continue; }
        const conflicted = [];
        for (const [path, text] of Object.entries(keyFiles(k, v))) {
          const known = this.state.files[path];
          if (known && known.text === stripBom(text)) continue; // inchangé
          const r = await Graph.upload(path, text, known && known.etag);
          if (r.conflict) { conflicted.push(path); continue; }
          this.state.files[path] = { etag: r.etag, text: stripBom(text) };
          this.persist();
        }
        if (conflicted.length) this.state.conflicts[k] = conflicted;
        else delete this.state.dirty[k];
      }
    },

    /* Récupère depuis OneDrive les fichiers qui ont changé. Renvoie true si quelque chose a changé. */
    async pull(k) {
      const folder = k === 'fc_accounts' ? '' : 'utilisateurs/' + k.slice(8);
      const names = k === 'fc_accounts' ? ['comptes.csv'] : CSV.USER_FILES;
      const listing = await Graph.list(folder);
      let changed = false;
      const texts = {};
      for (const name of names) {
        const path = (folder ? folder + '/' : '') + name;
        const info = listing[name], known = this.state.files[path];
        if (!info) { texts[name] = null; if (known) { delete this.state.files[path]; changed = true; } continue; }
        if (known && known.etag === info.etag) { texts[name] = known.text; continue; }
        const text = await Graph.download(info);
        this.state.files[path] = { etag: info.etag, text };
        texts[name] = text;
        if (!known || known.text !== text) changed = true;
      }
      if (!changed && k in this.state.data) return false;
      const v = k === 'fc_accounts' ? CSV.accountsFromCSV(texts['comptes.csv']) : CSV.filesToData(texts);
      const empty = k === 'fc_accounts' ? texts['comptes.csv'] === null : v === null;
      if (empty && this.state.data[k] && (k !== 'fc_accounts' || Object.keys(this.state.data[k]).length)) {
        // Pas encore de fichiers sur OneDrive pour cet utilisateur : on garde les données du téléphone et on les envoie.
        this.state.dirty[k] = true; await this.push(); return false;
      }
      this.cache[k] = v; this.state.data[k] = v;
      return changed;
    },

    /* ----- Résolution d'un conflit ----- */
    async resolve(keep) {
      const keys = Object.keys(this.state.conflicts);
      for (const k of keys) {
        const paths = this.state.conflicts[k];
        delete this.state.conflicts[k];
        if (keep === 'onedrive') {
          delete this.state.dirty[k];
          for (const p of paths) delete this.state.files[p]; // forcera le re-téléchargement
          delete this.state.data[k];
        } else {
          for (const p of paths) if (this.state.files[p]) this.state.files[p].etag = null; // écrasera la version OneDrive
          this.state.dirty[k] = true;
        }
      }
      this.persist();
      if (keep === 'onedrive') { for (const k of keys) await this.pull(k).catch(() => {}); this.persist(); }
      else await this.syncAll({});
      UI.reload(keep === 'onedrive' ? 'Version OneDrive rechargée.' : 'Version du téléphone envoyée sur OneDrive.');
    },

    disconnect() {
      Auth.logout(); ls.del(LS_STATE);
      try { sessionStorage.clear(); localStorage.removeItem('fc_remember'); } catch (e) { /* ignore */ }
      location.replace(redirectUri());
    },

    /* Textes affichés par app.js */
    authNote: 'Vos données sont enregistrées en fichiers CSV dans votre OneDrive (dossier Applications), au même format que sur votre ordinateur. Elles restent aussi sur ce téléphone pour fonctionner hors ligne.',
    settingsNote: (u) => 'Les données sont enregistrées en fichiers CSV dans votre OneDrive, dossier <code>Applications/…/utilisateurs/' + u + '/</code>, et gardées sur ce téléphone pour fonctionner hors ligne.',
  };

  /* ================= Interface (écran de connexion, indicateur de synchro) ================= */
  const UI = {
    screen(kind, error) {
      const app = document.getElementById('app');
      const body = kind === 'config'
        ? `<p>L'application n'est pas encore reliée à une inscription Microsoft.</p><p class="muted">Renseignez l'identifiant d'application (client ID) dans <code>config.js</code>, puis rechargez.</p>`
        : `<p>Pour retrouver les mêmes données que sur votre ordinateur, connectez votre compte Microsoft.</p>
           <p class="muted">Finance_Care pourra lire et écrire <strong>uniquement</strong> dans son propre dossier OneDrive (Applications), pas dans le reste de vos fichiers.</p>
           ${error ? `<p class="hint">⚠ ${esc(error)}</p>` : ''}
           <button class="btn primary block" id="fcod-login">Se connecter avec Microsoft</button>`;
      app.innerHTML = `<div class="auth"><div class="auth-card"><div class="brand big"><span class="logo">FC</span> Finance_Care</div>${body}</div></div>`;
      const btn = document.getElementById('fcod-login');
      if (btn) btn.onclick = () => { btn.disabled = true; btn.textContent = 'Ouverture de Microsoft…'; Auth.login(); };
    },
    reload(msg) { try { sessionStorage.setItem('fcod_toast', msg); } catch (e) { /* ignore */ } location.reload(); },
    pill: null,
    mountPill() {
      if (this.pill || !document.body) return;
      const el = document.createElement('button');
      el.className = 'sync-pill'; el.type = 'button';
      el.onclick = () => this.panel();
      document.body.appendChild(el);
      this.pill = el;
      const upd = () => {
        const m = { ok: ['☁', 'À jour', 'good'], pending: ['⏳', 'Envoi…', 'muted'], offline: ['☁', 'Hors ligne', 'warning'], conflict: ['⚠', 'Conflit', 'critical'], auth: ['🔑', 'Reconnexion', 'warning'], error: ['⚠', 'Erreur', 'critical'] }[Backend.status] || ['☁', '', 'muted'];
        el.className = 'sync-pill ' + m[2];
        el.innerHTML = `<span aria-hidden="true">${m[0]}</span> ${m[1]}`;
        el.title = Backend.message;
        el.setAttribute('aria-label', 'Synchronisation OneDrive : ' + (Backend.message || m[1]));
        if (Backend.status === 'conflict' && !this.conflictShown) { this.conflictShown = true; this.panel(); }
      };
      Backend.onStatus(upd); upd();
      const t = sessionStorage.getItem('fcod_toast');
      if (t) { sessionStorage.removeItem('fcod_toast'); this.flash(t); }
    },
    flash(msg) {
      const root = document.getElementById('toasts'); if (!root) return;
      const el = document.createElement('div'); el.className = 'toast info'; el.setAttribute('role', 'status'); el.textContent = msg;
      root.appendChild(el); setTimeout(() => el.remove(), 4000);
    },
    panel() {
      const old = document.getElementById('fcod-panel'); if (old) old.remove();
      const acc = Auth.account(), st = Backend.state;
      const conflict = Backend.status === 'conflict';
      const d = document.createElement('div');
      d.id = 'fcod-panel'; d.className = 'sync-panel'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Synchronisation OneDrive');
      d.innerHTML = `<div class="sync-card">
        <h3>${conflict ? '⚠ Conflit de données' : 'OneDrive'}</h3>
        ${conflict ? `<p>Des fichiers ont été modifiés sur OneDrive (par exemple depuis l'ordinateur) <strong>et</strong> sur ce téléphone depuis la dernière synchronisation. Rien n'a été écrasé. Quelle version garder ?</p>
          <button class="btn primary block" data-k="onedrive">Garder la version OneDrive (recommandé)</button>
          <p class="fineprint">Les dernières modifications faites sur ce téléphone seront perdues.</p>
          <button class="btn block" data-k="phone">Garder la version du téléphone</button>
          <p class="fineprint">Les modifications faites ailleurs sur ces fichiers seront remplacées.</p>`
        : `<p>${esc(Backend.message || '')}</p>
          <p class="muted">Compte : ${esc(acc.username || acc.name || '—')}<br>Dernière synchronisation : ${st.lastSync ? new Date(st.lastSync).toLocaleString('fr-FR') : 'jamais'}</p>
          <button class="btn primary block" data-k="sync">Synchroniser maintenant</button>
          ${Backend.status === 'auth' ? '<button class="btn block" data-k="relogin">Se reconnecter à Microsoft</button>' : ''}
          <button class="btn ghost block" data-k="logout">Déconnecter OneDrive de ce téléphone</button>`}
        <button class="btn ghost block" data-k="close">Fermer</button></div>`;
      d.addEventListener('click', async (e) => {
        const k = e.target.closest('[data-k]') && e.target.closest('[data-k]').dataset.k;
        if (!k && e.target !== d) return;
        if (!k || k === 'close') return d.remove();
        if (k === 'sync') { d.remove(); await Backend.syncAll({ pull: Backend.openKeys(), reloadIfChanged: true }); }
        else if (k === 'relogin') Auth.login();
        else if (k === 'onedrive' || k === 'phone') { d.remove(); await Backend.resolve(k); }
        else if (k === 'logout') {
          const n = Object.keys(Backend.state.dirty).length;
          if (n && !d.dataset.confirm) {
            d.dataset.confirm = '1';
            e.target.textContent = 'Des modifications ne sont pas encore envoyées : toucher à nouveau pour les perdre et déconnecter';
            return;
          }
          Backend.disconnect();
        }
      });
      document.body.appendChild(d);
    },
  };

  root.FC_BACKEND = Backend;
  root.FC_ONEDRIVE = { Auth, Graph, Backend, UI, CFG, AuthError };
})(typeof window !== 'undefined' ? window : globalThis);
