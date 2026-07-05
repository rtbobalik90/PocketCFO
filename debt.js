/* =========================================================
   Pocket CFO — store.js
   Data layer. localStorage persistence, demo seed data,
   and all derived financial math (recurring detection,
   safe-to-save, alerts, monthly rollups).
   No external dependencies.
   ========================================================= */
(function () {
  const KEY = 'pocketcfo.v1';

  const DEFAULTS = {
    settings: {
      backendUrl: '',        // Cloudflare Worker URL (enables AI coach + Plaid)
      userId: '',            // random id used to key Plaid tokens in the backend
      demoMode: false,
      emergencyTargetMonths: 3,
      currency: 'USD'
    },
    accounts: [],            // {id, name, type: cash|checking|savings|credit, balance, plaid:boolean}
    transactions: [],        // {id, date:'YYYY-MM-DD', merchant, amount(+in/-out), category, note, accountId, recurringOverride}
    debts: [],               // {id, name, balance, apr, minPayment, dueDay}
    goals: [],               // {id, name, target, saved, isEmergency}
    coachHistory: []         // chat messages {role, content}
  };

  const CATEGORIES = [
    'Income','Housing','Utilities','Groceries','Dining','Transport','Insurance',
    'Health','Kids','Subscriptions','Shopping','Entertainment','Debt Payment',
    'Savings','Giving','Other'
  ];
  const ESSENTIAL = new Set(['Housing','Utilities','Groceries','Transport','Insurance','Health','Kids','Debt Payment']);

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return deepMerge(structuredClone(DEFAULTS), parsed);
      }
    } catch (e) { console.warn('store load failed', e); }
    const fresh = structuredClone(DEFAULTS);
    fresh.settings.userId = uid();
    return fresh;
  }

  function deepMerge(base, over) {
    for (const k of Object.keys(over || {})) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k]) {
        deepMerge(base[k], over[k]);
      } else base[k] = over[k];
    }
    return base;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('store save failed', e); }
    document.dispatchEvent(new CustomEvent('store:changed'));
  }

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  /* ---------- date helpers ---------- */
  function today() { return new Date(); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function monthKey(dateStr) { return dateStr.slice(0, 7); }               // 'YYYY-MM'
  function thisMonthKey() { return iso(today()).slice(0, 7); }
  function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

  /* ---------- CRUD ---------- */
  const api = {
    get state() { return state; },
    CATEGORIES, ESSENTIAL,
    save, uid, monthKey, thisMonthKey, shiftMonth,

    addTransaction(t) { t.id = uid(); state.transactions.push(t); sortTx(); save(); return t; },
    updateTransaction(id, patch) { const t = state.transactions.find(x => x.id === id); if (t) Object.assign(t, patch); sortTx(); save(); },
    deleteTransaction(id) { state.transactions = state.transactions.filter(x => x.id !== id); save(); },

    addDebt(d) { d.id = uid(); state.debts.push(d); save(); return d; },
    updateDebt(id, patch) { const d = state.debts.find(x => x.id === id); if (d) Object.assign(d, patch); save(); },
    deleteDebt(id) { state.debts = state.debts.filter(x => x.id !== id); save(); },

    addGoal(g) { g.id = uid(); state.goals.push(g); save(); return g; },
    updateGoal(id, patch) { const g = state.goals.find(x => x.id === id); if (g) Object.assign(g, patch); save(); },
    deleteGoal(id) { state.goals = state.goals.filter(x => x.id !== id); save(); },

    addAccount(a) { a.id = uid(); state.accounts.push(a); save(); return a; },
    updateAccount(id, patch) { const a = state.accounts.find(x => x.id === id); if (a) Object.assign(a, patch); save(); },
    deleteAccount(id) { state.accounts = state.accounts.filter(x => x.id !== id); save(); },

    setSetting(k, v) { state.settings[k] = v; save(); },

    exportJSON() { return JSON.stringify(state, null, 2); },
    importJSON(json) { state = deepMerge(structuredClone(DEFAULTS), JSON.parse(json)); save(); },
    resetAll() { state = structuredClone(DEFAULTS); state.settings.userId = uid(); save(); }
  };

  function sortTx() { state.transactions.sort((a, b) => b.date.localeCompare(a.date)); }

  /* ---------- derived: monthly rollups ---------- */
  api.monthTotals = function (key) {
    let income = 0, spend = 0; const byCat = {};
    for (const t of state.transactions) {
      if (monthKey(t.date) !== key) continue;
      if (t.amount > 0) income += t.amount;
      else { spend += -t.amount; byCat[t.category] = (byCat[t.category] || 0) + -t.amount; }
    }
    return { income, spend, net: income - spend, byCat };
  };

  api.monthSeries = function (n) {
    // last n months of {key, income, spend}
    const out = []; let key = thisMonthKey();
    for (let i = 0; i < n; i++) { out.unshift({ key, ...api.monthTotals(key) }); key = shiftMonth(key, -1); }
    return out;
  };

  api.cashPosition = function () {
    return state.accounts.filter(a => a.type !== 'credit').reduce((s, a) => s + a.balance, 0);
  };

  api.netWorth = function () {
    const assets = api.cashPosition() + state.goals.reduce((s, g) => s + g.saved, 0);
    const creditBal = state.accounts.filter(a => a.type === 'credit').reduce((s, a) => s + Math.abs(a.balance), 0);
    const debt = state.debts.reduce((s, d) => s + d.balance, 0) + creditBal;
    return { assets, debt, net: assets - debt };
  };

  /* Daily balance sparkline: reconstruct last 30 days from current cash minus/plus tx */
  api.balanceSparkline = function (days = 30) {
    let bal = api.cashPosition();
    const pts = []; const t = today();
    const txByDay = {};
    for (const tx of state.transactions) (txByDay[tx.date] = txByDay[tx.date] || []).push(tx);
    for (let i = 0; i < days; i++) {
      const d = iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i));
      pts.unshift(bal);
      for (const tx of (txByDay[d] || [])) bal -= tx.amount; // walk backwards
    }
    return pts;
  };

  /* ---------- recurring / subscription detection ---------- */
  api.recurring = function () {
    const groups = {};
    for (const t of state.transactions) {
      if (t.amount >= 0) continue;
      const k = t.merchant.trim().toLowerCase();
      (groups[k] = groups[k] || []).push(t);
    }
    const out = [];
    for (const [k, list] of Object.entries(groups)) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date.localeCompare(b.date));
      const gaps = [];
      for (let i = 1; i < list.length; i++) gaps.push(daysBetween(list[i - 1].date, list[i].date));
      const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const amts = list.map(t => -t.amount);
      const avgAmt = amts.reduce((s, a) => s + a, 0) / amts.length;
      const steady = amts.every(a => Math.abs(a - avgAmt) / avgAmt < 0.2);
      const monthlyish = avgGap >= 21 && avgGap <= 40;
      const weeklyish = avgGap >= 5 && avgGap <= 9;
      if (steady && (monthlyish || weeklyish)) {
        out.push({
          merchant: list[list.length - 1].merchant,
          category: list[list.length - 1].category,
          amount: avgAmt,
          cadence: monthlyish ? 'monthly' : 'weekly',
          monthlyCost: monthlyish ? avgAmt : avgAmt * 4.33,
          lastDate: list[list.length - 1].date,
          count: list.length
        });
      }
    }
    return out.sort((a, b) => b.monthlyCost - a.monthlyCost);
  };

  /* ---------- unusual spending ---------- */
  api.unusualSpending = function () {
    const key = thisMonthKey();
    const history = {}; // category -> amounts from prior 3 months
    for (const t of state.transactions) {
      if (t.amount >= 0) continue;
      const mk = monthKey(t.date);
      if (mk === key) continue;
      if (shiftMonth(key, -3) > mk) continue;
      (history[t.category] = history[t.category] || []).push(-t.amount);
    }
    const flags = [];
    for (const t of state.transactions) {
      if (t.amount >= 0 || monthKey(t.date) !== key) continue;
      const h = history[t.category];
      if (!h || h.length < 3) continue;
      const avg = h.reduce((s, a) => s + a, 0) / h.length;
      if (-t.amount > Math.max(avg * 2.5, 75)) {
        flags.push({ tx: t, avg });
      }
    }
    return flags;
  };

  /* ---------- bills due soon (from debts + recurring) ---------- */
  api.billsDueSoon = function (withinDays = 10) {
    const t = today(); const out = [];
    for (const d of state.debts) {
      if (!d.dueDay) continue;
      let due = new Date(t.getFullYear(), t.getMonth(), d.dueDay);
      if (due < new Date(t.getFullYear(), t.getMonth(), t.getDate())) due = new Date(t.getFullYear(), t.getMonth() + 1, d.dueDay);
      const inDays = Math.round((due - t) / 86400000);
      if (inDays <= withinDays) out.push({ name: d.name, amount: d.minPayment, inDays, kind: 'debt' });
    }
    for (const r of api.recurring()) {
      if (r.cadence !== 'monthly') continue;
      const last = new Date(r.lastDate);
      const next = new Date(last.getFullYear(), last.getMonth() + 1, last.getDate());
      const inDays = Math.round((next - t) / 86400000);
      if (inDays >= 0 && inDays <= withinDays) out.push({ name: r.merchant, amount: r.amount, inDays, kind: 'recurring' });
    }
    return out.sort((a, b) => a.inDays - b.inDays);
  };

  /* ---------- safe to save ---------- */
  api.safeToSave = function () {
    const months = api.monthSeries(4).slice(0, 3); // last 3 full-ish months
    const usable = months.filter(m => m.income > 0 || m.spend > 0);
    if (!usable.length) return { amount: 0, detail: 'Not enough history yet. Add a month of transactions first.' };
    const avgIncome = usable.reduce((s, m) => s + m.income, 0) / usable.length;
    const avgEssential = usable.reduce((s, m) => {
      let e = 0; for (const [c, v] of Object.entries(m.byCat)) if (ESSENTIAL.has(c)) e += v;
      return s + e;
    }, 0) / usable.length;
    const avgLifestyle = usable.reduce((s, m) => s + m.spend, 0) / usable.length - avgEssential;
    const minimums = state.debts.reduce((s, d) => s + d.minPayment, 0);
    const buffer = avgIncome * 0.05;
    const amount = Math.max(0, avgIncome - avgEssential - Math.min(avgLifestyle, avgLifestyle * 0.6) - buffer);
    // Note: assumes you can trim ~40% of lifestyle spend; minimums are inside essentials via Debt Payment category, shown for context
    return { amount, avgIncome, avgEssential, avgLifestyle, minimums, buffer };
  };

  /* ---------- alerts ---------- */
  api.alerts = function () {
    const out = [];
    const key = thisMonthKey();
    const cur = api.monthTotals(key);
    const prev = api.monthTotals(shiftMonth(key, -1));

    if (cur.spend > cur.income && cur.income > 0)
      out.push({ level: 'bad', text: `You've spent ${fmt(cur.spend)} against ${fmt(cur.income)} of income this month. You are going backwards.` });

    for (const f of api.unusualSpending().slice(0, 2))
      out.push({ level: 'warn', text: `${f.tx.merchant} (${fmt(-f.tx.amount)}) is well above your usual ${f.tx.category} spend of ~${fmt(f.avg)}.` });

    const subs = api.recurring().filter(r => r.category === 'Subscriptions' || r.category === 'Entertainment');
    const subTotal = subs.reduce((s, r) => s + r.monthlyCost, 0);
    if (subTotal > 60)
      out.push({ level: 'warn', text: `${subs.length} subscriptions cost you ~${fmt(subTotal)}/mo — ${fmt(subTotal * 12)}/yr. Worth an audit.` });

    const bills = api.billsDueSoon(5);
    if (bills.length)
      out.push({ level: 'info', text: `${bills.length} payment${bills.length > 1 ? 's' : ''} due in the next 5 days (${fmt(bills.reduce((s, b) => s + b.amount, 0))} total).` });

    const ef = state.goals.find(g => g.isEmergency);
    if (ef) {
      const targetMonthly = (cur.spend || prev.spend || 0);
      if (targetMonthly && ef.saved < targetMonthly)
        out.push({ level: 'warn', text: `Emergency fund (${fmt(ef.saved)}) covers less than one month of spending. This is priority #1 after minimum payments.` });
    }

    if (!out.length) out.push({ level: 'good', text: 'No fires this week. Keep payments on time and let the plan work.' });
    return out;
  };

  /* ---------- coach strip: one honest sentence ---------- */
  api.coachStrip = function () {
    const key = thisMonthKey();
    const cur = api.monthTotals(key);
    const nw = api.netWorth();
    const debts = state.debts;
    const dining = cur.byCat['Dining'] || 0;
    const minSum = debts.reduce((s, d) => s + d.minPayment, 0);

    if (debts.length && dining > minSum && minSum > 0)
      return `Dining out (${fmt(dining)}) is more than your combined minimum debt payments (${fmt(minSum)}) this month. That's the lever.`;
    if (cur.net < 0 && cur.income > 0)
      return `You're ${fmt(-cur.net)} in the red this month. Nothing else matters until spending drops below income.`;
    if (debts.length) {
      const worst = [...debts].sort((a, b) => b.apr - a.apr)[0];
      const monthlyInterest = worst.balance * (worst.apr / 100) / 12;
      return `${worst.name} is charging you ~${fmt(monthlyInterest)} in interest every month. Every extra dollar goes there first.`;
    }
    if (nw.net > 0 && cur.net > 0)
      return `Cash-flow positive and debt-free territory: net worth ${fmt(nw.net)}. Now make savings automatic.`;
    return `Add your accounts, debts, and a month of transactions — then I can tell you the truth about your money.`;
  };

  function fmt(n) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  }
  api.fmt = fmt;
  api.fmt2 = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  /* ---------- financial summary for the AI coach ---------- */
  api.financialSummary = function () {
    const months = api.monthSeries(4);
    return {
      cashPosition: api.cashPosition(),
      netWorth: api.netWorth(),
      months: months.map(m => ({ month: m.key, income: Math.round(m.income), spend: Math.round(m.spend), byCategory: Object.fromEntries(Object.entries(m.byCat).map(([k, v]) => [k, Math.round(v)])) })),
      debts: state.debts.map(d => ({ name: d.name, balance: d.balance, apr: d.apr, minPayment: d.minPayment })),
      goals: state.goals.map(g => ({ name: g.name, target: g.target, saved: g.saved, isEmergency: !!g.isEmergency })),
      recurring: api.recurring().map(r => ({ merchant: r.merchant, monthlyCost: Math.round(r.monthlyCost) })),
      safeToSave: Math.round(api.safeToSave().amount || 0)
    };
  };

  /* ---------- demo data ---------- */
  api.loadDemo = function () {
    const t = today();
    const S = structuredClone(DEFAULTS);
    S.settings = { ...state.settings, demoMode: true };
    S.accounts = [
      { id: uid(), name: 'Checking', type: 'checking', balance: 3184.22, plaid: false },
      { id: uid(), name: 'Savings', type: 'savings', balance: 1450.00, plaid: false },
      { id: uid(), name: 'Visa •• 4417', type: 'credit', balance: -3240.55, plaid: false }
    ];
    S.debts = [
      { id: uid(), name: 'Visa •• 4417', balance: 3240.55, apr: 24.99, minPayment: 97, dueDay: 15 },
      { id: uid(), name: 'Car loan', balance: 11890.00, apr: 6.9, minPayment: 312, dueDay: 5 },
      { id: uid(), name: 'Store card', balance: 780.00, apr: 29.99, minPayment: 35, dueDay: 22 }
    ];
    S.goals = [
      { id: uid(), name: 'Emergency fund', target: 12000, saved: 1450, isEmergency: true },
      { id: uid(), name: 'Family road trip', target: 3500, saved: 620, isEmergency: false },
      { id: uid(), name: 'Christmas', target: 900, saved: 150, isEmergency: false }
    ];
    const tx = [];
    const push = (mOff, day, merchant, amount, category) => {
      const d = new Date(t.getFullYear(), t.getMonth() - mOff, day);
      if (d > t) return;
      tx.push({ id: uid(), date: iso(d), merchant, amount, category, note: '' });
    };
    for (let m = 3; m >= 0; m--) {
      push(m, 1, 'Paycheck', 2610, 'Income');
      push(m, 15, 'Paycheck', 2610, 'Income');
      push(m, 2, 'Rent — Maple St', -1450, 'Housing');
      push(m, 4, 'WE Energies', -(138 + m * 9), 'Utilities');
      push(m, 5, 'Car loan payment', -312, 'Debt Payment');
      push(m, 15, 'Visa payment', -150, 'Debt Payment');
      push(m, 6, 'State Farm', -164, 'Insurance');
      push(m, 3, 'Netflix', -15.49, 'Subscriptions');
      push(m, 9, 'Spotify', -11.99, 'Subscriptions');
      push(m, 12, 'Anytime Fitness', -24.99, 'Subscriptions');
      push(m, 7, 'Pick n Save', -(182 + (m % 2) * 31), 'Groceries');
      push(m, 14, 'Aldi', -(126 + m * 7), 'Groceries');
      push(m, 21, 'Pick n Save', -(158 - m * 4), 'Groceries');
      push(m, 8, 'Kwik Trip', -(52 + m * 3), 'Transport');
      push(m, 19, 'Kwik Trip', -48, 'Transport');
      push(m, 10, 'Culver\'s', -(34 + m * 2), 'Dining');
      push(m, 16, 'Chipotle', -41, 'Dining');
      push(m, 23, 'Pizza Ranch', -56, 'Dining');
      push(m, 26, 'Target', -(88 + (m % 3) * 22), 'Shopping');
      push(m, 27, 'Amazon', -(46 + m * 5), 'Shopping');
      push(m, 18, 'Kids activities', -75, 'Kids');
      push(m, 24, 'Church giving', -100, 'Giving');
    }
    // one unusual splurge this month
    push(0, Math.min(t.getDate(), 20), 'Best Buy', -389.99, 'Shopping');
    S.transactions = tx.sort((a, b) => b.date.localeCompare(a.date));
    S.settings.userId = state.settings.userId || uid();
    state = S; save();
  };

  window.Store = api;
})();
