// Version mobile : format CSV identique au PC + synchronisation OneDrive (OneDrive simulé)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');

/* ---- environnement navigateur minimal ---- */
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
global.window = global; global.localStorage = mem(); global.sessionStorage = mem();
let reloads = [];
global.location = { href: 'https://exemple.github.io/finance-care/', reload: () => reloads.push(1), replace() {}, assign() {} };
Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true });
global.FCCSV = require('../csvformat.js');
require('../sync.js');
const { Backend, Graph } = global.FC_SYNC;
const realDropbox = { ...global.FC_SYNC.Dropbox }; // copie avant simulation
const CSV = global.FCCSV;

/* ---- OneDrive simulé ---- */
let drive, n;
function resetDrive() { drive = {}; n = 0; }
const etag = () => '"e' + (++n) + '"';
Graph.list = async (folder) => {
  const out = {}; const pre = folder ? folder + '/' : '';
  for (const [p, f] of Object.entries(drive)) if (p.startsWith(pre) && !p.slice(pre.length).includes('/')) out[p.slice(pre.length)] = { etag: f.etag, url: p };
  return out;
};
Graph.download = async (info) => drive[info.url].text.replace(/^﻿/, '');
Graph.upload = async (p, text, et) => {
  if (et && drive[p] && drive[p].etag !== et) return { conflict: true };
  drive[p] = { text, etag: etag() }; return { etag: drive[p].etag };
};
const pcWrite = (p, text) => { drive[p] = { text, etag: etag() }; }; // modification faite depuis le PC
function freshPhone() {
  localStorage.clear(); sessionStorage.clear(); reloads = [];
  Backend.state = { files: {}, data: {}, dirty: {}, conflicts: {}, lastSync: null }; Backend.cache = {};
}
const sample = () => JSON.parse(JSON.stringify({
  version: 2, onboarded: true,
  profile: { name: 'Sam', currency: 'EUR', salary: { amount: 2400.5, frequency: 'mensuel', day: 3, accountId: 'principal' } },
  accounts: [{ id: 'principal', name: 'Compte courant', type: 'courant', color: '#1b64be', initialBalance: 120.5, archived: false },
    { id: 'livret', name: 'Livret A; "épargne"', type: 'livret', color: '#00a37a', initialBalance: 3000, archived: true }],
  categories: [{ id: 'logement', name: 'Logement', color: '#f47230' }],
  incomes: [{ id: 'i1', date: '2026-11-01', amount: 2400.5, type: 'salaire', label: 'Salaire', accountId: 'principal' }],
  expenses: [{ id: 'e1', date: '2026-11-05', amount: 750, categoryId: 'logement', kind: 'fixe', label: 'Loyer; "appart"', accountId: 'livret' }],
  recurring: [], budgets: { '2026-11': { global: 1700, categories: { logement: 750 } } },
  goals: [{ id: 'g1', name: 'Vacances', type: 'vacances', target: 1500, deadline: '', createdAt: '2026-11-01', percent: 8, archived: false, contributions: [{ id: 'c1', date: '2026-11-01', amount: 200, note: '' }] }],
}));
let removed = [];
Graph.remove = async (folder) => { removed.push(folder); for (const p of Object.keys(drive)) if (p.startsWith(folder + '/')) delete drive[p]; };

test('format CSV : octet pour octet identique à la version PC (server.js)', () => {
  process.env.FINANCE_CARE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-'));
  const S = require('../../finance_care/server.js');
  const d = sample();
  S.saveUserData('sam', d);
  const files = CSV.dataToFiles(d);
  for (const [name, text] of Object.entries(files)) {
    assert.strictEqual(fs.readFileSync(path.join(process.env.FINANCE_CARE_DATA, 'utilisateurs', 'sam', name), 'utf8'), text, name);
  }
  assert.deepStrictEqual(CSV.filesToData(files), S.loadUserData('sam'));
  const acc = { sam: { salt: 's', hash: 'h', createdAt: '2026-11-25' } };
  S.saveAccounts(acc);
  assert.strictEqual(fs.readFileSync(path.join(process.env.FINANCE_CARE_DATA, 'comptes.csv'), 'utf8'), CSV.accountsToCSV(acc));
  assert.deepStrictEqual(CSV.accountsFromCSV(CSV.accountsToCSV(acc)), acc);
});

test('le téléphone lit les fichiers écrits par le PC', async () => {
  resetDrive(); freshPhone();
  pcWrite('comptes.csv', CSV.accountsToCSV({ sam: { salt: 's', hash: 'h', createdAt: '2026-11-25' } }));
  for (const [name, text] of Object.entries(CSV.dataToFiles(sample()))) pcWrite('utilisateurs/sam/' + name, text);
  await Backend.syncAll({ pull: ['fc_accounts'] });
  assert.deepStrictEqual(Object.keys(Backend.cache.fc_accounts), ['sam']);
  await Backend.loadUser('sam');
  assert.deepStrictEqual(Backend.cache.fc_data_sam, sample());
  assert.strictEqual(Backend.status, 'ok');
});

test("une modification n'envoie que les fichiers qui ont changé", async () => {
  const before = JSON.parse(JSON.stringify(drive));
  const d = sample(); d.expenses.push({ id: 'e2', date: '2026-11-20', amount: 12.5, categoryId: 'logement', kind: 'variable', label: 'Ampoules' });
  Backend.write('fc_data_sam', d);
  assert.strictEqual(Backend.status, 'pending');
  assert.ok(JSON.parse(localStorage.getItem('fcod_state')).dirty.fc_data_sam, 'gardé sur le téléphone avant envoi');
  await Backend.syncAll({});
  const changed = Object.keys(drive).filter((p) => drive[p].etag !== before[p].etag);
  assert.deepStrictEqual(changed, ['utilisateurs/sam/depenses.csv']);
  assert.match(drive['utilisateurs/sam/depenses.csv'].text, /Ampoules/);
  assert.strictEqual(Backend.status, 'ok');
  clearTimeout(Backend.timers.fc_data_sam);
});

test('hors ligne : modifications gardées puis envoyées au retour du réseau', async () => {
  navigator.onLine = false;
  const d = JSON.parse(JSON.stringify(Backend.cache.fc_data_sam)); d.incomes.push({ id: 'i2', date: '2026-11-21', amount: 50, type: 'supplementaire', label: 'Vente' });
  Backend.write('fc_data_sam', d); clearTimeout(Backend.timers.fc_data_sam);
  await Backend.syncAll({});
  assert.strictEqual(Backend.status, 'offline');
  assert.doesNotMatch(drive['utilisateurs/sam/revenus.csv'].text, /Vente/);
  navigator.onLine = true;
  await Backend.syncAll({});
  assert.match(drive['utilisateurs/sam/revenus.csv'].text, /Vente/);
  assert.strictEqual(Backend.status, 'ok');
});

test('modifs sur des fichiers différents (PC et téléphone) : aucune perte', async () => {
  // PC : nouvel objectif ; téléphone (hors ligne) : nouvelle dépense
  const pc = CSV.filesToData({ ...Object.fromEntries(Object.entries(drive).filter(([p]) => p.startsWith('utilisateurs/sam/')).map(([p, f]) => [p.split('/').pop(), f.text])) });
  pc.goals.push({ id: 'g2', name: 'Voiture', type: 'voiture', target: 5000, deadline: '', createdAt: '2026-11-22', percent: 0, archived: false, contributions: [] });
  pcWrite('utilisateurs/sam/objectifs.csv', CSV.dataToFiles(pc)['objectifs.csv']);
  const d = JSON.parse(JSON.stringify(Backend.cache.fc_data_sam)); d.expenses.push({ id: 'e3', date: '2026-11-22', amount: 30, categoryId: 'logement', kind: 'variable', label: 'Peinture' });
  Backend.write('fc_data_sam', d); clearTimeout(Backend.timers.fc_data_sam);
  await Backend.syncAll({ pull: ['fc_data_sam'], reloadIfChanged: true });
  assert.match(drive['utilisateurs/sam/depenses.csv'].text, /Peinture/);
  assert.match(drive['utilisateurs/sam/objectifs.csv'].text, /Voiture/, "l'objectif du PC n'est pas écrasé");
  assert.ok(Backend.cache.fc_data_sam.goals.some((g) => g.name === 'Voiture'), 'le téléphone récupère la modif du PC');
  assert.ok(Backend.cache.fc_data_sam.expenses.some((e) => e.label === 'Peinture'));
  assert.strictEqual(reloads.length, 1, "l'écran est rechargé avec les nouvelles données");
});

test('même fichier modifié des deux côtés : conflit, rien n\'est écrasé, puis choix', async () => {
  const pc = CSV.filesToData(Object.fromEntries(Object.entries(drive).filter(([p]) => p.startsWith('utilisateurs/sam/')).map(([p, f]) => [p.split('/').pop(), f.text])));
  pc.expenses.push({ id: 'pc1', date: '2026-11-23', amount: 99, categoryId: 'logement', kind: 'variable', label: 'Achat PC' });
  pcWrite('utilisateurs/sam/depenses.csv', CSV.dataToFiles(pc)['depenses.csv']);
  const d = JSON.parse(JSON.stringify(Backend.cache.fc_data_sam)); d.expenses.push({ id: 'ph1', date: '2026-11-23', amount: 5, categoryId: 'logement', kind: 'variable', label: 'Achat tel' });
  Backend.write('fc_data_sam', d); clearTimeout(Backend.timers.fc_data_sam);
  await Backend.syncAll({});
  assert.strictEqual(Backend.status, 'conflict');
  assert.match(drive['utilisateurs/sam/depenses.csv'].text, /Achat PC/);
  assert.doesNotMatch(drive['utilisateurs/sam/depenses.csv'].text, /Achat tel/);
  await Backend.resolve('cloud');
  assert.ok(Backend.cache.fc_data_sam.expenses.some((e) => e.label === 'Achat PC'));
  assert.ok(!Backend.cache.fc_data_sam.expenses.some((e) => e.label === 'Achat tel'));
  assert.deepStrictEqual(Backend.state.conflicts, {});

  // Second conflit, cette fois on garde le téléphone
  pc.expenses.push({ id: 'pc2', date: '2026-11-24', amount: 1, categoryId: 'logement', kind: 'variable', label: 'PC bis' });
  pcWrite('utilisateurs/sam/depenses.csv', CSV.dataToFiles(pc)['depenses.csv']);
  const d2 = JSON.parse(JSON.stringify(Backend.cache.fc_data_sam)); d2.expenses.push({ id: 'ph2', date: '2026-11-24', amount: 2, categoryId: 'logement', kind: 'variable', label: 'Tel bis' });
  Backend.write('fc_data_sam', d2); clearTimeout(Backend.timers.fc_data_sam);
  await Backend.syncAll({});
  assert.strictEqual(Backend.status, 'conflict');
  await Backend.resolve('phone');
  assert.match(drive['utilisateurs/sam/depenses.csv'].text, /Tel bis/);
  assert.strictEqual(Backend.status, 'ok');
});

test('premier lancement sans fichiers sur OneDrive : compte créé sur le téléphone puis envoyé', async () => {
  resetDrive(); freshPhone();
  await Backend.syncAll({ pull: ['fc_accounts'] });
  assert.deepStrictEqual(Backend.cache.fc_accounts, {});
  Backend.write('fc_accounts', { sam: { salt: 's', hash: 'h', createdAt: '2026-11-25' } });
  Backend.write('fc_data_sam', sample());
  clearTimeout(Backend.timers.fc_accounts); clearTimeout(Backend.timers.fc_data_sam);
  await Backend.syncAll({});
  assert.ok(drive['comptes.csv']);
  assert.deepStrictEqual(Object.keys(drive).filter((p) => p.startsWith('utilisateurs/sam/')).map((p) => p.split('/').pop()).sort(), CSV.USER_FILES.slice().sort());
});

test('anciens fichiers (sans comptes bancaires) : tout va dans le « Compte principal »', () => {
  const old = {
    'profil.csv': '﻿cle;valeur\r\nnom;Sam\r\ndevise;EUR\r\nsalaire_montant;2000\r\nsalaire_frequence;mensuel\r\nsalaire_jour;1\r\nconfiguration_terminee;oui\r\nversion;1\r\n',
    'revenus.csv': '﻿id;date;montant;type;libelle\r\ni1;2026-11-01;2000;salaire;Salaire\r\n',
    'depenses.csv': '﻿id;date;montant;categorie_id;type;libelle;recurrente_id\r\ne1;2026-11-02;10;autres;variable;Café;\r\n',
    'recurrentes.csv': '﻿id;libelle;montant;categorie_id;jour;debut;fin;active;mois_ignores\r\nr1;Loyer;700;logement;5;2026-01;;oui;\r\n',
  };
  const d = CSV.filesToData(old);
  assert.deepStrictEqual(d.accounts, [CSV.DEFAULT_BANK]);
  assert.strictEqual(d.incomes[0].accountId, 'principal');
  assert.strictEqual(d.expenses[0].accountId, 'principal');
  assert.strictEqual(d.recurring[0].accountId, 'principal');
  assert.strictEqual(d.profile.salary.accountId, 'principal');
  const f = CSV.dataToFiles(d);
  assert.match(f['depenses.csv'], /compte_id/);
  assert.match(f['comptes_bancaires.csv'], /principal;Compte principal;courant/);
  // Un ancien programme qui réécrit depenses.csv sans la colonne : les opérations restent lisibles (compte principal)
  const d2 = CSV.filesToData({ ...f, 'depenses.csv': old['depenses.csv'] });
  assert.strictEqual(d2.expenses[0].accountId, 'principal');
});

test('calculs : solde par compte et sélection de comptes', () => {
  const FC = require('../calc.js');
  const d = sample();
  assert.strictEqual(FC.accountBalance(d, 'principal', '2026-11-30'), 2521);
  assert.strictEqual(FC.accountBalance(d, 'livret', '2026-11-30'), 2250);
  assert.strictEqual(FC.accountBalance(d, 'livret', '2026-11-04'), 3000, 'dépense future non comptée');
  const only = FC.scopeData(d, ['livret']);
  assert.strictEqual(only.incomes.length, 0); assert.strictEqual(only.expenses.length, 1);
  assert.strictEqual(FC.monthlySalary(only), 0, 'salaire versé sur un autre compte');
  assert.strictEqual(FC.scopeData(d, []), d);
  assert.strictEqual(FC.monthSummary(FC.scopeData(d, ['principal', 'livret']), '2026-11', '2026-11-30').totalExpenses, 750);
  d.recurring.push({ id: 'r1', label: 'Box', amount: 30, categoryId: 'logement', day: 2, startMonth: '2026-11', endMonth: '', active: true, skipped: [], accountId: 'livret' });
  FC.applyRecurring(d, '2026-11-30', () => 'x1');
  assert.strictEqual(d.expenses.find((e) => e.recurringId === 'r1').accountId, 'livret');
});

test('suppression de compte : dossier effacé dans le cloud, jamais recréé', async () => {
  resetDrive(); freshPhone(); removed = [];
  Backend.write('fc_accounts', { sam: { salt: 's', hash: 'h', createdAt: '2026-11-25' }, lea: { salt: 's', hash: 'h', createdAt: '2026-11-25' } });
  Backend.write('fc_data_sam', sample()); Backend.write('fc_data_lea', sample());
  clearTimeout(Backend.timers.fc_accounts); clearTimeout(Backend.timers.fc_data_sam); clearTimeout(Backend.timers.fc_data_lea);
  await Backend.syncAll({});
  assert.ok(drive['utilisateurs/sam/profil.csv']);
  // hors ligne : la suppression attend le retour du réseau
  navigator.onLine = false;
  await Backend.remove('fc_data_sam');
  Backend.write('fc_accounts', { lea: { salt: 's', hash: 'h', createdAt: '2026-11-25' } }); clearTimeout(Backend.timers.fc_accounts);
  assert.ok(!('fc_data_sam' in Backend.state.data), 'effacé du téléphone tout de suite');
  assert.ok(drive['utilisateurs/sam/profil.csv'], 'pas encore dans le cloud');
  navigator.onLine = true;
  await Backend.syncAll({});
  assert.deepStrictEqual(removed, ['utilisateurs/sam']);
  assert.ok(!Object.keys(drive).some((p) => p.startsWith('utilisateurs/sam/')));
  assert.ok(drive['utilisateurs/lea/profil.csv'], "l'autre utilisateur est intact");
  assert.doesNotMatch(drive['comptes.csv'].text, /sam/);
  assert.deepStrictEqual(Backend.state.deletes, {});
});

test('compte supprimé depuis le PC : le téléphone ne le recrée pas', async () => {
  resetDrive(); freshPhone();
  pcWrite('comptes.csv', CSV.accountsToCSV({ lea: { salt: 's', hash: 'h', createdAt: '2026-11-25' } }));
  // le téléphone avait encore une copie locale de « sam »
  Backend.state.data.fc_data_sam = sample(); Backend.cache.fc_data_sam = sample();
  await Backend.syncAll({ pull: ['fc_accounts'] });
  await Backend.loadUser('sam');
  assert.strictEqual(Backend.cache.fc_data_sam, null);
  assert.ok(!Object.keys(drive).some((p) => p.startsWith('utilisateurs/sam/')), 'aucun fichier renvoyé');
});

test('changement de nom : nouveau dossier envoyé avant la suppression de l\'ancien', async () => {
  resetDrive(); freshPhone(); removed = [];
  const order = []; const up = Graph.upload; Graph.upload = async (p, t, e) => { order.push('up:' + p.split('/')[1]); return up(p, t, e); };
  Backend.write('fc_accounts', { sam: { salt: 's', hash: 'h', createdAt: '2026-11-25' } }); Backend.write('fc_data_sam', sample());
  clearTimeout(Backend.timers.fc_accounts); clearTimeout(Backend.timers.fc_data_sam);
  await Backend.syncAll({}); order.length = 0;
  Backend.write('fc_data_samuel', sample()); Backend.write('fc_accounts', { samuel: { salt: 's', hash: 'h', createdAt: '2026-11-25' } });
  await Backend.remove('fc_data_sam');
  clearTimeout(Backend.timers.fc_accounts); clearTimeout(Backend.timers.fc_data_samuel);
  Graph.upload = up;
  assert.ok(drive['utilisateurs/samuel/depenses.csv']);
  assert.ok(!drive['utilisateurs/sam/depenses.csv']);
  assert.ok(order.indexOf('up:samuel') >= 0 && order.indexOf('up:samuel') < order.length, 'envoyé');
  assert.deepStrictEqual(removed, ['utilisateurs/sam']);
});

test('Dropbox : appels API (liste, téléchargement, envoi, conflit)', async () => {
  const calls = [];
  localStorage.setItem('fcod_auth', JSON.stringify({ access_token: 'tok', expires_at: Date.now() + 3600e3, refresh_token: 'r' }));
  global.fetch = async (url, opt = {}) => {
    calls.push({ url, opt });
    const arg = opt.headers && opt.headers['Dropbox-API-Arg'] ? JSON.parse(opt.headers['Dropbox-API-Arg']) : null;
    if (url.endsWith('/files/list_folder')) {
      const body = JSON.parse(opt.body);
      if (body.path === '/utilisateurs/inconnu') return new Response('{"error_summary":"path/not_found/"}', { status: 409 });
      return new Response(JSON.stringify({ entries: [{ '.tag': 'file', name: 'comptes.csv', rev: 'a1', path_lower: '/comptes.csv' }, { '.tag': 'folder', name: 'utilisateurs' }], has_more: false }), { status: 200 });
    }
    if (url.endsWith('/files/download')) return new Response('﻿utilisateur;sel;empreinte;cree_le\r\n', { status: 200 });
    if (url.endsWith('/files/upload')) {
      if (arg.mode['.tag'] === 'update' && arg.mode.update !== 'a1') return new Response('{"error_summary":"path/conflict/file/"}', { status: 409 });
      return new Response(JSON.stringify({ rev: 'a2' }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const Store = realDropbox;
  assert.deepStrictEqual(await Store.list('utilisateurs/inconnu'), {});
  const l = await Store.list('');
  assert.deepStrictEqual(Object.keys(l), ['comptes.csv']);
  assert.strictEqual(await Store.download(l['comptes.csv']), 'utilisateur;sel;empreinte;cree_le\r\n');
  assert.deepStrictEqual(await Store.upload('comptes.csv', 'x', 'a1'), { etag: 'a2' });
  assert.deepStrictEqual(await Store.upload('comptes.csv', 'x', 'vieux'), { conflict: true });
  assert.deepStrictEqual(await Store.upload('utilisateurs/élodie/profil.csv', 'x', null), { etag: 'a2' });
  const last = calls[calls.length - 1];
  assert.match(last.opt.headers['Dropbox-API-Arg'], /\\u00e9lodie/, 'en-tête ASCII uniquement');
  assert.strictEqual(JSON.parse(last.opt.headers['Dropbox-API-Arg']).mode['.tag'], 'overwrite');
  assert.strictEqual(last.opt.headers.Authorization, 'Bearer tok');
});

test('Dropbox : suppression d\'un dossier', async () => {
  const calls = [];
  global.fetch = async (url, opt = {}) => { calls.push({ url, body: opt.body }); return url.endsWith('/files/delete_v2') && JSON.parse(opt.body).path === '/utilisateurs/absent' ? new Response('{}', { status: 409 }) : new Response('{}', { status: 200 }); };
  await realDropbox.remove('utilisateurs/sam');
  await realDropbox.remove('utilisateurs/absent'); // déjà supprimé : pas d'erreur
  assert.strictEqual(calls[0].url, 'https://api.dropboxapi.com/2/files/delete_v2');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { path: '/utilisateurs/sam' });
});
