/* Finance_Care — format des fichiers CSV.
 * Copie fidèle de la logique de server.js (version PC) : mêmes fichiers, mêmes colonnes,
 * même séparateur « ; », même encodage (UTF-8 avec BOM, fins de ligne CRLF).
 * Ainsi le téléphone et l'ordinateur lisent et écrivent exactement les mêmes fichiers.
 * Fonctionne dans le navigateur (window.FCCSV) et dans Node (tests). */
(function (root) {
  'use strict';
  const SEP = ';';

  function csvCell(v) {
    const s = v === undefined || v === null ? '' : String(v);
    return /[;"\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(columns, rows) {
    const lines = [columns.join(SEP)];
    for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(SEP));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === SEP) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const nonEmpty = rows.filter((r) => r.some((c) => c !== ''));
    if (!nonEmpty.length) return [];
    const head = nonEmpty[0].map((h) => h.trim());
    return nonEmpty.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
  }

  const n = (v) => { const x = parseFloat(String(v).replace(',', '.')); return isNaN(x) ? 0 : x; };
  const b = (v) => v === true || v === 'oui' || v === '1' || v === 'true';
  const yn = (v) => (v ? 'oui' : 'non');
  const validUser = (u) => /^[a-z0-9._-]{1,40}$/.test(u) && !/^\.+$/.test(u);

  const T = {
    profil: ['cle', 'valeur'],
    categories: ['id', 'nom', 'couleur'],
    revenus: ['id', 'date', 'montant', 'type', 'libelle'],
    depenses: ['id', 'date', 'montant', 'categorie_id', 'type', 'libelle', 'recurrente_id'],
    recurrentes: ['id', 'libelle', 'montant', 'categorie_id', 'jour', 'debut', 'fin', 'active', 'mois_ignores'],
    budgets: ['mois', 'categorie_id', 'montant'],
    objectifs: ['id', 'nom', 'type', 'montant_cible', 'date_limite', 'cree_le', 'pourcentage_salaire', 'archive'],
    versements: ['id', 'objectif_id', 'date', 'montant', 'note'],
  };
  const USER_FILES = Object.keys(T).map((k) => k + '.csv');
  const ACCOUNTS_COLS = ['utilisateur', 'sel', 'empreinte', 'cree_le'];

  /* comptes.csv */
  function accountsToCSV(acc) {
    const rows = Object.entries(acc || {}).filter(([u]) => validUser(u))
      .map(([u, a]) => ({ utilisateur: u, sel: a.salt, empreinte: a.hash, cree_le: a.createdAt }));
    return toCSV(ACCOUNTS_COLS, rows);
  }
  function accountsFromCSV(text) {
    const out = {};
    if (text === null || text === undefined) return out;
    for (const r of parseCSV(text)) if (r.utilisateur) out[r.utilisateur] = { salt: r.sel, hash: r.empreinte, createdAt: r.cree_le };
    return out;
  }

  /* données d'un utilisateur → { 'profil.csv': texte, ... } */
  function dataToFiles(d) {
    const p = d.profile || {}; const s = p.salary || {};
    const f = {};
    f['profil.csv'] = toCSV(T.profil, [
      { cle: 'nom', valeur: p.name }, { cle: 'devise', valeur: p.currency },
      { cle: 'salaire_montant', valeur: s.amount }, { cle: 'salaire_frequence', valeur: s.frequency }, { cle: 'salaire_jour', valeur: s.day },
      { cle: 'configuration_terminee', valeur: yn(d.onboarded) }, { cle: 'version', valeur: d.version || 1 },
    ]);
    f['categories.csv'] = toCSV(T.categories, (d.categories || []).map((c) => ({ id: c.id, nom: c.name, couleur: c.color })));
    f['revenus.csv'] = toCSV(T.revenus, (d.incomes || []).map((i) => ({ id: i.id, date: i.date, montant: i.amount, type: i.type, libelle: i.label })));
    f['depenses.csv'] = toCSV(T.depenses, (d.expenses || []).map((e) => ({ id: e.id, date: e.date, montant: e.amount, categorie_id: e.categoryId, type: e.kind, libelle: e.label, recurrente_id: e.recurringId || '' })));
    f['recurrentes.csv'] = toCSV(T.recurrentes, (d.recurring || []).map((r) => ({ id: r.id, libelle: r.label, montant: r.amount, categorie_id: r.categoryId, jour: r.day, debut: r.startMonth, fin: r.endMonth || '', active: yn(r.active), mois_ignores: (r.skipped || []).join('|') })));
    const budgets = [];
    for (const [mois, bg] of Object.entries(d.budgets || {})) {
      budgets.push({ mois, categorie_id: '_global', montant: bg.global || 0 });
      for (const [cid, m] of Object.entries(bg.categories || {})) budgets.push({ mois, categorie_id: cid, montant: m });
    }
    f['budgets.csv'] = toCSV(T.budgets, budgets);
    f['objectifs.csv'] = toCSV(T.objectifs, (d.goals || []).map((g) => ({ id: g.id, nom: g.name, type: g.type, montant_cible: g.target, date_limite: g.deadline || '', cree_le: g.createdAt || '', pourcentage_salaire: g.percent || 0, archive: yn(g.archived) })));
    const vers = [];
    for (const g of d.goals || []) for (const c of g.contributions || []) vers.push({ id: c.id, objectif_id: g.id, date: c.date, montant: c.amount, note: c.note || '' });
    f['versements.csv'] = toCSV(T.versements, vers);
    return f;
  }

  /* { 'profil.csv': texte|null, ... } → données (null si pas de profil) */
  function filesToData(files) {
    if (files['profil.csv'] === null || files['profil.csv'] === undefined) return null;
    const kv = Object.fromEntries(parseCSV(files['profil.csv']).map((r) => [r.cle, r.valeur]));
    const rd = (name) => { const t = files[name + '.csv']; return t === null || t === undefined ? [] : parseCSV(t); };
    const budgets = {};
    for (const r of rd('budgets')) {
      const bg = budgets[r.mois] || (budgets[r.mois] = { global: 0, categories: {} });
      if (r.categorie_id === '_global') bg.global = n(r.montant); else bg.categories[r.categorie_id] = n(r.montant);
    }
    const vers = rd('versements');
    return {
      version: n(kv.version) || 1,
      onboarded: b(kv.configuration_terminee),
      profile: { name: kv.nom || '', currency: kv.devise || 'EUR', salary: { amount: n(kv.salaire_montant), frequency: kv.salaire_frequence || 'mensuel', day: n(kv.salaire_jour) || 1 } },
      categories: rd('categories').map((c) => ({ id: c.id, name: c.nom, color: c.couleur || '#8d8d8d' })),
      incomes: rd('revenus').map((i) => ({ id: i.id, date: i.date, amount: n(i.montant), type: i.type || 'supplementaire', label: i.libelle })),
      expenses: rd('depenses').map((e) => {
        const o = { id: e.id, date: e.date, amount: n(e.montant), categoryId: e.categorie_id, kind: e.type === 'fixe' ? 'fixe' : 'variable', label: e.libelle };
        if (e.recurrente_id) o.recurringId = e.recurrente_id;
        return o;
      }),
      recurring: rd('recurrentes').map((r) => ({ id: r.id, label: r.libelle, amount: n(r.montant), categoryId: r.categorie_id, day: n(r.jour) || 1, startMonth: r.debut, endMonth: r.fin || '', active: b(r.active), skipped: r.mois_ignores ? r.mois_ignores.split('|') : [] })),
      budgets,
      goals: rd('objectifs').map((g) => ({
        id: g.id, name: g.nom, type: g.type || 'autre', target: n(g.montant_cible), deadline: g.date_limite || '', createdAt: g.cree_le || '',
        percent: n(g.pourcentage_salaire), archived: b(g.archive),
        contributions: vers.filter((v) => v.objectif_id === g.id).map((v) => ({ id: v.id, date: v.date, amount: n(v.montant), note: v.note })),
      })),
    };
  }

  const FCCSV = { SEP, toCSV, parseCSV, T, USER_FILES, validUser, accountsToCSV, accountsFromCSV, dataToFiles, filesToData };
  if (typeof module !== 'undefined' && module.exports) module.exports = FCCSV; else root.FCCSV = FCCSV;
})(typeof window !== 'undefined' ? window : globalThis);
