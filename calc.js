/* Finance_Care — fonctions de calcul (pures, testables avec Node) */
(function (root) {
  'use strict';

  const DEFAULT_CATEGORIES = [
    { id: 'alimentation', name: 'Alimentation', color: '#257de0' },
    { id: 'logement', name: 'Logement', color: '#f47230' },
    { id: 'transport', name: 'Transport', color: '#00b894' },
    { id: 'loisirs', name: 'Loisirs', color: '#f2a600' },
    { id: 'sante', name: 'Santé', color: '#ee7fac' },
    { id: 'abonnements', name: 'Abonnements', color: '#008a17' },
    { id: 'assurances', name: 'Assurances', color: '#6a4ce2' },
    { id: 'autres', name: 'Autres', color: '#ec4647' },
  ];

  const FREQUENCIES = {
    mensuel: { label: 'Mensuel', perMonth: 1 },
    quinzaine: { label: 'Deux fois par mois', perMonth: 2 },
    deux_semaines: { label: 'Toutes les deux semaines', perMonth: 26 / 12 },
    hebdomadaire: { label: 'Hebdomadaire', perMonth: 52 / 12 },
  };

  const PALETTE = ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17', '#6a4ce2', '#ec4647'];
  const ALERT_WARN = 0.8; // 80 % du budget consommé → alerte « proche de la limite »

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f ? f(x) : x) || 0), 0);

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISODate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function monthOf(dateStr) { return String(dateStr).slice(0, 7); }
  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); }
  function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); }
  function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function monthRange(from, to) {
    const out = [];
    let m = from;
    while (m <= to && out.length < 600) { out.push(m); m = addMonths(m, 1); }
    return out;
  }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

  function perMonth(freq) { return (FREQUENCIES[freq] || FREQUENCIES.mensuel).perMonth; }

  /* ---------- Salaire ---------- */
  function monthlySalary(data) {
    const s = (data.profile && data.profile.salary) || {};
    return round2((Number(s.amount) || 0) * perMonth(s.frequency));
  }

  /* ---------- Dépenses récurrentes (3.1) ----------
     Génère les dépenses récurrentes dont la date est passée et qui n'existent pas encore.
     Renvoie le nombre de dépenses ajoutées. */
  function applyRecurring(data, today, makeId) {
    let added = 0;
    const curMonth = monthOf(today);
    for (const r of data.recurring || []) {
      if (!r.active) continue;
      const start = r.startMonth || curMonth;
      const end = r.endMonth && r.endMonth < curMonth ? r.endMonth : curMonth;
      for (const m of monthRange(start, end)) {
        if ((r.skipped || []).includes(m)) continue;
        const date = recurringDate(r, m);
        if (date > today) continue;
        const exists = data.expenses.some((e) => e.recurringId === r.id && monthOf(e.date) === m);
        if (exists) continue;
        data.expenses.push({
          id: makeId(), date, amount: round2(r.amount), categoryId: r.categoryId,
          kind: 'fixe', label: r.label, recurringId: r.id,
          ...(r.accountId ? { accountId: r.accountId } : {}),
        });
        added++;
      }
    }
    return added;
  }
  function recurringDate(r, month) {
    const day = Math.min(Math.max(1, Number(r.day) || 1), daysInMonth(month));
    return month + '-' + pad(day);
  }
  /* Dépenses récurrentes encore à venir dans le mois (pas encore générées). */
  function pendingRecurring(data, month, today) {
    const out = [];
    for (const r of data.recurring || []) {
      if (!r.active) continue;
      if ((r.startMonth || month) > month) continue;
      if (r.endMonth && r.endMonth < month) continue;
      if ((r.skipped || []).includes(month)) continue;
      const exists = data.expenses.some((e) => e.recurringId === r.id && monthOf(e.date) === month);
      if (exists) continue;
      const date = recurringDate(r, month);
      if (date >= today || month > monthOf(today)) out.push({ ...r, date });
    }
    return out;
  }

  /* ---------- Budget (2.3) ---------- */
  /* Le budget d'un mois est celui défini pour ce mois ou, à défaut, le dernier budget défini avant. */
  function budgetFor(data, month) {
    const budgets = data.budgets || {};
    if (budgets[month]) return { ...budgets[month], month, inherited: false };
    const prev = Object.keys(budgets).filter((k) => k < month).sort().pop();
    if (prev) return { ...budgets[prev], month, inherited: true, from: prev };
    return { global: 0, categories: {}, month, inherited: true, from: null };
  }

  function statusFor(spent, budget) {
    if (!budget) return 'none';
    const r = spent / budget;
    if (r > 1) return 'over';
    if (r >= ALERT_WARN) return 'warn';
    return 'ok';
  }

  /* ---------- Objectifs d'épargne (2.4) ---------- */
  function goalSaved(goal, upToDate) {
    return round2(sum((goal.contributions || []).filter((c) => !upToDate || c.date <= upToDate), (c) => c.amount));
  }
  function goalStats(goal, today, data) {
    const saved = goalSaved(goal);
    const target = Number(goal.target) || 0;
    const remaining = round2(Math.max(0, target - saved));
    const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
    const daysLeft = goal.deadline ? daysBetween(today, goal.deadline) : null;
    const monthsLeft = daysLeft === null ? null : Math.max(0, daysLeft / 30.4375);
    let monthlyNeeded = null;
    if (remaining <= 0) monthlyNeeded = 0;
    else if (monthsLeft !== null) monthlyNeeded = round2(remaining / Math.max(1, monthsLeft));
    const freq = data && data.profile && data.profile.salary ? data.profile.salary.frequency : 'mensuel';
    const perSalaryNeeded = monthlyNeeded === null ? null : round2(monthlyNeeded / perMonth(freq));
    const salary = data ? monthlySalary(data) : 0;
    const recommendedPercent = monthlyNeeded !== null && salary > 0 ? round2((monthlyNeeded / salary) * 100) : null;

    // En bonne voie ? progression réelle vs progression attendue (linéaire depuis la création)
    let status = 'en_cours';
    if (remaining <= 0) status = 'atteint';
    else if (daysLeft !== null && daysLeft < 0) status = 'depasse';
    else if (goal.deadline && goal.createdAt) {
      const total = Math.max(1, daysBetween(goal.createdAt, goal.deadline));
      const elapsed = Math.min(total, Math.max(0, daysBetween(goal.createdAt, today)));
      const expected = (elapsed / total) * 100;
      // Avec le pourcentage de salaire actuel, l'objectif sera-t-il atteint à temps ?
      const plannedMonthly = salary * (Number(goal.percent) || 0) / 100;
      const projected = saved + plannedMonthly * (monthsLeft || 0);
      if (pct + 1e-9 >= expected || projected + 0.005 >= target) status = 'bonne_voie';
      else status = 'retard';
    }
    const plannedMonthly = round2(salary * (Number(goal.percent) || 0) / 100);
    return { saved, target, remaining, pct, daysLeft, monthsLeft, monthlyNeeded, perSalaryNeeded,
      recommendedPercent, status, plannedMonthly, plannedPerSalary: round2(plannedMonthly / perMonth(freq)) };
  }

  /* ---------- Répartition du salaire (2.5) ---------- */
  function salaryAllocation(data, month) {
    const salary = monthlySalary(data);
    const freq = (data.profile && data.profile.salary && data.profile.salary.frequency) || 'mensuel';
    const goals = (data.goals || []).filter((g) => !g.archived);
    const perGoal = goals.map((g) => {
      const pct = Number(g.percent) || 0;
      const monthly = round2(salary * pct / 100);
      return { id: g.id, name: g.name, percent: pct, monthly, perSalary: round2(monthly / perMonth(freq)) };
    });
    const savings = round2(sum(perGoal, (g) => g.monthly));
    const savingsPercent = sum(perGoal, (g) => g.percent);
    const budget = budgetFor(data, month);
    const expenses = round2(Number(budget.global) || 0);
    const available = round2(salary - savings - expenses);
    return {
      salary, perSalary: Number((data.profile && data.profile.salary && data.profile.salary.amount) || 0),
      frequency: freq, perGoal, savings, savingsPercent, expenses,
      expensesPercent: salary ? (expenses / salary) * 100 : 0,
      available, availablePercent: salary ? (available / salary) * 100 : 0,
      overAllocated: available < 0,
    };
  }

  /* Répartit un salaire reçu entre les objectifs selon leurs pourcentages. */
  function splitSalary(data, amount) {
    return (data.goals || []).filter((g) => !g.archived && Number(g.percent) > 0)
      .map((g) => ({ goalId: g.id, name: g.name, amount: round2(amount * Number(g.percent) / 100) }));
  }

  /* Ajustement automatique : pourcentage nécessaire pour atteindre chaque objectif à temps. */
  function recommendedPercents(data, today) {
    const out = {};
    for (const g of data.goals || []) {
      if (g.archived) continue;
      const st = goalStats(g, today, data);
      out[g.id] = st.recommendedPercent === null ? (Number(g.percent) || 0) : Math.ceil(st.recommendedPercent * 10) / 10;
    }
    return out;
  }

  /* ---------- Synthèse mensuelle (2.6, 3.2) ---------- */
  function monthSummary(data, month, today) {
    const incomes = (data.incomes || []).filter((i) => monthOf(i.date) === month);
    const expenses = (data.expenses || []).filter((e) => monthOf(e.date) === month);
    const contributions = [];
    for (const g of data.goals || []) {
      for (const c of g.contributions || []) if (monthOf(c.date) === month) contributions.push({ ...c, goalId: g.id });
    }
    const totalIncome = round2(sum(incomes, (i) => i.amount));
    const salaryIncome = round2(sum(incomes.filter((i) => i.type === 'salaire'), (i) => i.amount));
    const totalExpenses = round2(sum(expenses, (e) => e.amount));
    const fixed = round2(sum(expenses.filter((e) => e.kind === 'fixe'), (e) => e.amount));
    const variable = round2(totalExpenses - fixed);
    const savings = round2(sum(contributions, (c) => c.amount));
    const balance = round2(totalIncome - totalExpenses - savings);

    const cats = data.categories || [];
    const budget = budgetFor(data, month);
    const pending = pendingRecurring(data, month, today);
    const byCategory = cats.map((c) => {
      const spent = round2(sum(expenses.filter((e) => e.categoryId === c.id), (e) => e.amount));
      const planned = round2(sum(pending.filter((p) => p.categoryId === c.id), (p) => p.amount));
      const b = Number((budget.categories || {})[c.id]) || 0;
      return { ...c, spent, planned, budget: b, remaining: round2(b - spent), pct: b ? (spent / b) * 100 : null,
        status: statusFor(spent, b), statusWithPlanned: statusFor(spent + planned, b) };
    });
    const knownIds = new Set(cats.map((c) => c.id));
    const orphan = round2(sum(expenses.filter((e) => !knownIds.has(e.categoryId)), (e) => e.amount));
    if (orphan) byCategory.push({ id: '_none', name: 'Sans catégorie', color: '#adb5bd', spent: orphan, planned: 0, budget: 0, remaining: -orphan, pct: null, status: 'none', statusWithPlanned: 'none' });

    const globalBudget = Number(budget.global) || 0;
    const pendingTotal = round2(sum(pending, (p) => p.amount));
    const budgetInfo = {
      ...budget, global: globalBudget, spent: totalExpenses, planned: pendingTotal,
      remaining: round2(globalBudget - totalExpenses),
      remainingAfterPlanned: round2(globalBudget - totalExpenses - pendingTotal),
      pct: globalBudget ? (totalExpenses / globalBudget) * 100 : null,
      status: statusFor(totalExpenses, globalBudget),
      statusWithPlanned: statusFor(totalExpenses + pendingTotal, globalBudget),
    };

    const currency = (data.profile && data.profile.currency) || 'EUR';
    const fmt = (n) => fmtMoney(n, currency);
    const alerts = [];
    if (budgetInfo.status === 'over') alerts.push({ level: 'over', text: `Budget global dépassé de ${fmt(-budgetInfo.remaining)}` });
    else if (budgetInfo.status === 'warn') alerts.push({ level: 'warn', text: `Budget global consommé à ${Math.round(budgetInfo.pct)} % — il reste ${fmt(budgetInfo.remaining)}` });
    else if (budgetInfo.statusWithPlanned === 'over') alerts.push({ level: 'warn', text: `Avec les dépenses récurrentes à venir, le budget global sera dépassé` });
    for (const c of byCategory) {
      if (c.status === 'over') alerts.push({ level: 'over', categoryId: c.id, text: `${c.name} : budget dépassé de ${fmt(-c.remaining)}` });
      else if (c.status === 'warn') alerts.push({ level: 'warn', categoryId: c.id, text: `${c.name} : ${Math.round(c.pct)} % du budget utilisé` });
    }

    return {
      month, incomes, expenses, contributions, totalIncome, salaryIncome, totalExpenses, fixed, variable,
      savings, balance, byCategory, budget: budgetInfo, pending, pendingTotal, alerts,
      savingsRate: totalIncome ? (savings / totalIncome) * 100 : 0,
    };
  }

  /* ---------- Prévision de fin de mois (3.3) ---------- */
  function forecast(data, month, today) {
    const s = monthSummary(data, month, today);
    const curMonth = monthOf(today);
    const dim = daysInMonth(month);
    let dayIndex; // nombre de jours écoulés dans le mois
    if (month < curMonth) dayIndex = dim; else if (month > curMonth) dayIndex = 0; else dayIndex = Number(today.slice(8, 10));
    const daysLeft = dim - dayIndex;

    // Revenus attendus : salaire mensuel prévu non encore reçu ce mois-ci
    const expectedSalary = monthlySalary(data);
    const expectedIncome = month < curMonth ? 0 : round2(Math.max(0, expectedSalary - s.salaryIncome));

    // Épargne prévue : objectifs (pourcentage du salaire) non encore versée ce mois-ci
    const alloc = salaryAllocation(data, month);
    const plannedSavings = month < curMonth ? 0 : round2(Math.max(0, alloc.savings - s.savings));

    // Dépenses variables restantes estimées au rythme actuel (si on est dans le mois)
    const variablePace = dayIndex > 0 ? s.variable / dayIndex : 0;
    let projectedVariable = round2(variablePace * daysLeft);
    // Si un budget est défini, on prend le minimum entre le rythme et le budget variable restant (estimation réaliste)
    const plannedFixed = s.pendingTotal;

    const endBalance = round2(s.totalIncome + expectedIncome - s.totalExpenses - plannedFixed - s.savings - plannedSavings);
    const endBalanceWithPace = round2(endBalance - projectedVariable);
    const perDayLeft = daysLeft > 0 ? round2(Math.max(0, endBalance) / daysLeft) : null;
    return {
      currentBalance: s.balance, expectedIncome, plannedFixed, plannedSavings, projectedVariable,
      endBalance, endBalanceWithPace, daysLeft, perDayLeft,
      canStillSpend: round2(Math.max(0, Math.min(endBalance, s.budget.global ? s.budget.remainingAfterPlanned : endBalance))),
    };
  }

  /* ---------- Historique (3.2) ---------- */
  function history(data, months, today) {
    return months.map((m) => {
      const s = monthSummary(data, m, today);
      return { month: m, income: s.totalIncome, expenses: s.totalExpenses, savings: s.savings, balance: s.balance,
        budget: s.budget.global, byCategory: s.byCategory };
    });
  }
  function compareMonths(data, a, b, today) {
    const A = monthSummary(data, a, today), B = monthSummary(data, b, today);
    const delta = (x, y) => ({ a: x, b: y, diff: round2(y - x), pct: x ? ((y - x) / Math.abs(x)) * 100 : null });
    const cats = (data.categories || []).map((c) => {
      const ca = A.byCategory.find((x) => x.id === c.id), cb = B.byCategory.find((x) => x.id === c.id);
      return { id: c.id, name: c.name, color: c.color, ...delta(ca ? ca.spent : 0, cb ? cb.spent : 0) };
    }).filter((c) => c.a || c.b);
    return { income: delta(A.totalIncome, B.totalIncome), expenses: delta(A.totalExpenses, B.totalExpenses),
      savings: delta(A.savings, B.savings), balance: delta(A.balance, B.balance), categories: cats };
  }

  /* ---------- Comptes bancaires ----------
     Solde d'un compte = solde de départ + revenus − dépenses enregistrés jusqu'à aujourd'hui. */
  function accountBalance(data, accountId, today) {
    const a = (data.accounts || []).find((x) => x.id === accountId);
    if (!a) return 0;
    const upTo = (x) => x.accountId === accountId && (!today || x.date <= today);
    return round2((Number(a.initialBalance) || 0) + sum((data.incomes || []).filter(upTo), (i) => i.amount) - sum((data.expenses || []).filter(upTo), (e) => e.amount));
  }
  /* Vue des données limitée à certains comptes (ids). Sans sélection (null ou vide) : toutes les données.
     Le salaire prévu n'est compté que si son compte de versement fait partie de la sélection. */
  function scopeData(data, ids) {
    if (!ids || !ids.length) return data;
    const set = new Set(ids);
    const keep = (x) => set.has(x.accountId);
    const salary = data.profile && data.profile.salary ? data.profile.salary : {};
    const salaryIn = !salary.accountId || set.has(salary.accountId);
    return {
      ...data,
      incomes: (data.incomes || []).filter(keep),
      expenses: (data.expenses || []).filter(keep),
      recurring: (data.recurring || []).filter(keep),
      profile: salaryIn ? data.profile : { ...data.profile, salary: { ...salary, amount: 0 } },
    };
  }

  function fmtMoney(n, currency) {
    try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'EUR' }).format(round2(n)); }
    catch (e) { return round2(n).toFixed(2) + ' ' + (currency || ''); }
  }

  const FC = {
    DEFAULT_CATEGORIES, PALETTE, FREQUENCIES, ALERT_WARN, round2, sum, toISODate, monthOf, addMonths, monthRange,
    daysInMonth, daysBetween, perMonth, monthlySalary, applyRecurring, pendingRecurring, budgetFor, statusFor,
    goalSaved, goalStats, accountBalance, scopeData, salaryAllocation, splitSalary, recommendedPercents, monthSummary, forecast, history,
    compareMonths, fmtMoney,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = FC; else root.FC = FC;
})(typeof window !== 'undefined' ? window : globalThis);
