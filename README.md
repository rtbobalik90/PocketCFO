/* Headless jsdom harness — boots the app, loads demo data,
   exercises every screen, and unit-checks the engines. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  // strip external font links for offline test
  .replace(/<link[^>]+fonts[^>]*>/g, '');

const dom = new JSDOM(html, { url: 'https://rtbobalik90.github.io/pocket-cfo/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// --- shims jsdom lacks ---
window.HTMLCanvasElement.prototype.getContext = function () {
  const ctxProxy = new Proxy({}, {
    get: (t, k) => {
      if (k === 'measureText') return () => ({ width: 10 });
      return (...args) => ctxProxy; // every method returns a chainable proxy (gradients get addColorStop, etc.)
    },
    set: () => true
  });
  return ctxProxy;
};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
window.confirm = () => true;
window.prompt = () => '50';
window.scrollTo = () => {};
window.structuredClone = window.structuredClone || (o => JSON.parse(JSON.stringify(o)));

let failures = 0;
function check(name, cond) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ FAIL ' + name); failures++; }
}

// load scripts in order
for (const f of ['js/store.js', 'js/charts.js', 'js/debt.js', 'js/coach.js', 'js/app.js']) {
  window.eval(fs.readFileSync(path.join(root, f), 'utf8'));
}
const doc = window.document, S = window.Store;

console.log('\n[boot / empty state]');
check('home screen rendered', doc.querySelector('#screen-home .card'));
check('empty-state CTA present', doc.querySelector('[data-act="demo"]'));
check('coach strip present', doc.querySelector('.coachstrip'));

console.log('\n[demo data]');
S.loadDemo();
check('transactions seeded', S.state.transactions.length > 60);
check('3 debts seeded', S.state.debts.length === 3);
check('emergency goal seeded', S.state.goals.some(g => g.isEmergency));

console.log('\n[derived math]');
const key = S.thisMonthKey();
const tot = S.monthTotals(key);
check('month totals computed', tot.income >= 0 && tot.spend > 0);
const rec = S.recurring();
check('recurring detection finds subscriptions', rec.some(r => r.merchant === 'Netflix'));
check('recurring monthly cost sane', rec.every(r => r.monthlyCost > 0 && r.monthlyCost < 2000));
check('rent detected as recurring', rec.some(r => /Rent/.test(r.merchant)));
const unusual = S.unusualSpending();
check('unusual spend flags Best Buy splurge', unusual.some(f => f.tx.merchant === 'Best Buy'));
const sts = S.safeToSave();
check('safe-to-save computes a number', typeof sts.amount === 'number' && sts.amount >= 0);
const nw = S.netWorth();
check('net worth math (assets - debt)', Math.abs(nw.net - (nw.assets - nw.debt)) < 0.01);
check('bills due soon returns array', Array.isArray(S.billsDueSoon(10)));
check('alerts generated', S.alerts().length > 0);
check('sparkline 30 points', S.balanceSparkline(30).length === 30);

console.log('\n[debt engine]');
const D = window.DebtEngine;
const debts = S.state.debts;
const av = D.simulate(debts, 300, 'avalanche');
const sn = D.simulate(debts, 300, 'snowball');
const mn = D.simulate(debts, 0, 'minimum');
check('avalanche finishes', av.finished && av.months > 0);
check('snowball finishes', sn.finished);
check('avalanche interest <= snowball interest', av.totalInterest <= sn.totalInterest + 0.01);
check('extra payments beat minimums (time)', av.months < mn.months || !mn.finished);
check('extra payments beat minimums (interest)', av.totalInterest < mn.totalInterest || !mn.finished);
check('balance series monotonic-ish end at 0', av.balanceSeries[av.balanceSeries.length - 1] < 1);
const analysis = D.analyze(debts, 300, 'avalanche', sts.amount);
check('analyze returns advice', analysis.advice.length > 0);
const stalledSim = D.simulate([{ name: 'Trap', balance: 5000, apr: 30, minPayment: 50 }], 0, 'minimum');
check('stall detection (min < interest)', stalledSim.stalled === true);
const aggressive = D.analyze(debts, Math.max(500, (sts.amount || 0) * 3), 'avalanche', sts.amount || 200);
check('too-aggressive plan gets warned', aggressive.advice.some(a => a.level === 'warn' && /above what/.test(a.text)));

console.log('\n[screens render with data]');
for (const s of ['home', 'money', 'debt', 'goals', 'coach', 'reports', 'settings']) {
  doc.querySelector(`[data-nav="${s}"]`)?.click() ??
    doc.querySelectorAll('[data-nav]').forEach(b => { if (b.dataset.nav === s) b.click(); });
  const scr = doc.querySelector('#screen-' + s);
  check(s + ' renders content', scr && scr.innerHTML.length > 100);
}

console.log('\n[transactions CRUD via modal]');
doc.querySelector('[data-nav="money"]').click();
doc.querySelector('[data-act="tx-add"]').click();
let modal = doc.querySelector('.modal');
check('tx modal opens', !!modal);
modal.querySelector('#m_merchant').value = 'Test Coffee';
modal.querySelector('#m_amount').value = '4.50';
modal.querySelector('#m_save').click();
check('tx added', S.state.transactions.some(t => t.merchant === 'Test Coffee' && t.amount === -4.5));
const added = S.state.transactions.find(t => t.merchant === 'Test Coffee');
S.updateTransaction(added.id, { amount: -6 });
check('tx updated', S.state.transactions.find(t => t.id === added.id).amount === -6);
S.deleteTransaction(added.id);
check('tx deleted', !S.state.transactions.find(t => t.id === added.id));

console.log('\n[goal funding creates a savings transaction]');
const goal = S.state.goals.find(g => !g.isEmergency);
const before = goal.saved;
doc.querySelector('[data-nav="goals"]').click();
doc.querySelector(`[data-act="goal-fund"][data-id="${goal.id}"][data-amt="25"]`).click();
check('goal saved amount +25', S.state.goals.find(g => g.id === goal.id).saved === before + 25);
check('savings tx logged', S.state.transactions.some(t => t.merchant.startsWith('Transfer to') && t.amount === -25));

console.log('\n[local coach answers]');
(async () => {
  const r1 = await window.Coach.ask('How do I pay off my debt?');
  check('coach: debt answer uses numbers', /\$/.test(r1) && r1.length > 80);
  const r2 = await window.Coach.ask('Audit my subscriptions');
  check('coach: subscriptions listed', /Netflix/.test(r2));
  const r3 = await window.Coach.ask('hello');
  check('coach: default assessment', /Cash:/.test(r3));

  console.log('\n[persistence + export]');
  const json = S.exportJSON();
  check('export JSON valid', JSON.parse(json).transactions.length === S.state.transactions.length);
  S.resetAll();
  check('reset clears data', S.state.transactions.length === 0);
  S.importJSON(json);
  check('import restores data', S.state.transactions.length > 60);

  console.log('\n' + (failures ? `❌ ${failures} FAILURE(S)` : '✅ ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
})();
