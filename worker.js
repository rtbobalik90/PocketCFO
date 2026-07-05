/* =========================================================
   Pocket CFO — app.js
   Screens, routing, rendering, modals, Plaid Link glue,
   reports, and exports. Depends on store.js, charts.js,
   debt.js, coach.js.
   ========================================================= */
(function () {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];
  const S = window.Store;
  const fmt = S.fmt, fmt2 = S.fmt2;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- routing ---------------- */
  const screens = ['home', 'money', 'debt', 'goals', 'coach', 'reports', 'settings'];
  let current = 'home';
  let moneyMonth = S.thisMonthKey();
  let moneyFilter = { cat: '', q: '' };
  let debtExtra = null, debtStrategy = 'avalanche';

  function nav(to) {
    current = to;
    $$('.screen').forEach(el => el.classList.toggle('active', el.id === 'screen-' + to));
    $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.nav === to));
    render();
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', e => {
    const n = e.target.closest('[data-nav]');
    if (n) { nav(n.dataset.nav); return; }
    const act = e.target.closest('[data-act]');
    if (act) handleAction(act.dataset.act, act.dataset);
  });

  document.addEventListener('store:changed', () => render());
  window.addEventListener('resize', debounce(() => render(), 200));

  /* ---------------- render dispatch ---------------- */
  function render() {
    ({ home: renderHome, money: renderMoney, debt: renderDebt, goals: renderGoals, coach: renderCoach, reports: renderReports, settings: renderSettings })[current]();
  }

  /* ================= HOME ================= */
  function renderHome() {
    const el = $('#screen-home');
    const cash = S.cashPosition();
    const nw = S.netWorth();
    const cur = S.monthTotals(S.thisMonthKey());
    const bills = S.billsDueSoon(10);
    const debts = S.state.debts;
    const debtTotal = debts.reduce((s, d) => s + d.balance, 0);
    const ef = S.state.goals.find(g => g.isEmergency);
    const alerts = S.alerts();
    const empty = !S.state.transactions.length && !debts.length;

    el.innerHTML = `
      <header class="apphead">
        <div>
          <div class="brand">POCKET CFO</div>
          <div class="date">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
        <div class="headbtns">
          <button class="iconbtn" data-nav="reports" title="Reports">▤</button>
          <button class="iconbtn" data-nav="settings" title="Settings">⚙</button>
        </div>
      </header>

      <div class="coachstrip" data-nav="coach">
        <span class="cs-label">COACH</span>
        <span class="cs-text">${esc(S.coachStrip())}</span>
      </div>

      ${empty ? `
      <div class="card empty">
        <h3>Start with the truth</h3>
        <p>Add your accounts and this month's transactions, or load demo data to explore first.</p>
        <div class="row gap">
          <button class="btn gold" data-act="demo">Load demo data</button>
          <button class="btn" data-act="tx-add">Add a transaction</button>
        </div>
      </div>` : ''}

      <div class="card hero">
        <div class="hero-label">CASH POSITION</div>
        <div class="hero-figure mono">${fmt2(cash)}</div>
        <canvas id="spark" class="spark"></canvas>
        <div class="hero-sub">
          <span>Net worth <b class="mono ${nw.net >= 0 ? 'pos' : 'neg'}">${fmt(nw.net)}</b></span>
          <span>30-day balance</span>
        </div>
      </div>

      <div class="statrow">
        <div class="stat">
          <div class="stat-label">IN · THIS MONTH</div>
          <div class="stat-val mono pos">${fmt(cur.income)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">OUT · THIS MONTH</div>
          <div class="stat-val mono neg">${fmt(cur.spend)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">NET</div>
          <div class="stat-val mono ${cur.net >= 0 ? 'pos' : 'neg'}">${cur.net >= 0 ? '+' : ''}${fmt(cur.net)}</div>
        </div>
      </div>

      ${bills.length ? `
      <div class="card">
        <div class="card-title">Due soon</div>
        ${bills.slice(0, 4).map(b => `
          <div class="rowline">
            <div><b>${esc(b.name)}</b><span class="sub">${b.inDays === 0 ? 'today' : `in ${b.inDays} day${b.inDays > 1 ? 's' : ''}`}</span></div>
            <div class="mono">${fmt(b.amount)}</div>
          </div>`).join('')}
      </div>` : ''}

      ${debts.length ? `
      <div class="card tap" data-nav="debt">
        <div class="card-title">Debt <span class="chev">›</span></div>
        <div class="bigline"><span class="mono neg">${fmt(debtTotal)}</span><span class="sub">across ${debts.length} account${debts.length > 1 ? 's' : ''}</span></div>
        <div class="minitags">${debts.slice(0, 3).map(d => `<span class="tag">${esc(d.name)} · ${d.apr}%</span>`).join('')}</div>
      </div>` : ''}

      ${ef ? `
      <div class="card tap" data-nav="goals">
        <div class="card-title">Emergency fund <span class="chev">›</span></div>
        <div class="progress"><div class="bar gold" style="width:${Math.min(100, ef.saved / ef.target * 100)}%"></div></div>
        <div class="rowline"><span class="mono">${fmt(ef.saved)} of ${fmt(ef.target)}</span><span class="sub">${Math.round(ef.saved / ef.target * 100)}%</span></div>
      </div>` : ''}

      <div class="card">
        <div class="card-title">Alerts & recommendations</div>
        ${alerts.map(a => `<div class="alert ${a.level}">${esc(a.text)}</div>`).join('')}
      </div>
    `;
    const spark = $('#spark');
    if (spark) Charts.sparkline(spark, S.balanceSparkline(30));
  }

  /* ================= MONEY (transactions) ================= */
  function renderMoney() {
    const el = $('#screen-money');
    const key = moneyMonth;
    const tot = S.monthTotals(key);
    const [y, m] = key.split('-');
    const monthName = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const recurring = S.recurring();
    const recKeys = new Set(recurring.map(r => r.merchant.toLowerCase()));

    let txs = S.state.transactions.filter(t => S.monthKey(t.date) === key);
    if (moneyFilter.cat) txs = txs.filter(t => t.category === moneyFilter.cat);
    if (moneyFilter.q) { const q = moneyFilter.q.toLowerCase(); txs = txs.filter(t => t.merchant.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q)); }

    const byDate = {};
    for (const t of txs) (byDate[t.date] = byDate[t.date] || []).push(t);
    const cats = Object.entries(tot.byCat).sort((a, b) => b[1] - a[1]);

    el.innerHTML = `
      <header class="apphead">
        <div class="monthnav">
          <button class="iconbtn" data-act="month" data-d="-1">‹</button>
          <h2>${monthName}</h2>
          <button class="iconbtn" data-act="month" data-d="1" ${key >= S.thisMonthKey() ? 'disabled' : ''}>›</button>
        </div>
        <button class="btn gold small" data-act="tx-add">+ Add</button>
      </header>

      <div class="statrow">
        <div class="stat"><div class="stat-label">IN</div><div class="stat-val mono pos">${fmt(tot.income)}</div></div>
        <div class="stat"><div class="stat-label">OUT</div><div class="stat-val mono neg">${fmt(tot.spend)}</div></div>
        <div class="stat"><div class="stat-label">NET</div><div class="stat-val mono ${tot.net >= 0 ? 'pos' : 'neg'}">${tot.net >= 0 ? '+' : ''}${fmt(tot.net)}</div></div>
      </div>

      <div class="card"><canvas id="flowbars" class="bars"></canvas></div>

      ${cats.length ? `
      <div class="card">
        <div class="card-title">Spending by category</div>
        <div class="donutwrap"><canvas id="catdonut" class="donut"></canvas>
          <div class="legend">
            ${cats.slice(0, 6).map(([c, v], i) => `
              <button class="legenditem ${moneyFilter.cat === c ? 'on' : ''}" data-act="filter-cat" data-cat="${esc(c)}">
                <span class="dot" style="background:${Charts.DONUT_COLORS[i % Charts.DONUT_COLORS.length]}"></span>
                ${esc(c)} <b class="mono">${fmt(v)}</b>
              </button>`).join('')}
          </div>
        </div>
      </div>` : ''}

      <div class="searchrow">
        <input id="txsearch" type="search" placeholder="Search merchant or note…" value="${esc(moneyFilter.q)}">
        ${moneyFilter.cat ? `<button class="tag on" data-act="filter-cat" data-cat="${esc(moneyFilter.cat)}">${esc(moneyFilter.cat)} ✕</button>` : ''}
      </div>

      ${Object.keys(byDate).length ? Object.keys(byDate).sort().reverse().map(d => `
        <div class="datehead">${new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>
        ${byDate[d].map(t => `
          <button class="txrow" data-act="tx-edit" data-id="${t.id}">
            <div class="txmain">
              <b>${esc(t.merchant)}</b>
              <span class="sub">${esc(t.category)}${recKeys.has(t.merchant.toLowerCase()) ? ' · <i class="rec">↻ recurring</i>' : ''}${t.note ? ' · ' + esc(t.note) : ''}</span>
            </div>
            <div class="mono ${t.amount >= 0 ? 'pos' : ''}">${t.amount >= 0 ? '+' : ''}${fmt2(t.amount)}</div>
          </button>`).join('')}
      `).join('') : `<div class="card empty"><p>No transactions ${moneyFilter.cat || moneyFilter.q ? 'match this filter' : 'this month'}. ${moneyFilter.cat || moneyFilter.q ? '' : 'Tap <b>+ Add</b> to log your first one.'}</p></div>`}
    `;

    Charts.cashflowBars($('#flowbars'), S.monthSeries(6));
    const dc = $('#catdonut');
    if (dc) Charts.donut(dc, cats.slice(0, 8), 'spent', fmt(tot.spend));
    const search = $('#txsearch');
    search.addEventListener('input', debounce(() => { moneyFilter.q = search.value; renderMoney(); const s2 = $('#txsearch'); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }, 350));
  }

  /* ================= DEBT ================= */
  function renderDebt() {
    const el = $('#screen-debt');
    const debts = S.state.debts;
    const sts = S.safeToSave();
    if (debtExtra === null) debtExtra = Math.max(0, Math.round((sts.amount || 0) / 25) * 25);

    let analysis = null;
    if (debts.length) analysis = DebtEngine.analyze(debts, debtExtra, debtStrategy, sts.amount ?? null);

    el.innerHTML = `
      <header class="apphead"><h2>Debt payoff</h2><button class="btn gold small" data-act="debt-add">+ Add debt</button></header>

      ${!debts.length ? `
      <div class="card empty">
        <h3>Know the enemy</h3>
        <p>Add each debt with its balance, APR, and minimum payment. I'll build the payoff order, timeline, and tell you what it really costs.</p>
        <button class="btn gold" data-act="debt-add">Add your first debt</button>
      </div>` : `

      <div class="card">
        <div class="card-title">Your debts · ${fmt(debts.reduce((s, d) => s + d.balance, 0))} total</div>
        ${[...debts].sort((a, b) => b.apr - a.apr).map(d => `
          <button class="txrow" data-act="debt-edit" data-id="${d.id}">
            <div class="txmain"><b>${esc(d.name)}</b><span class="sub">${d.apr}% APR · min ${fmt(d.minPayment)}${d.dueDay ? ' · due the ' + ord(d.dueDay) : ''}</span></div>
            <div class="mono neg">${fmt(d.balance)}</div>
          </button>`).join('')}
      </div>

      <div class="card">
        <div class="card-title">Strategy</div>
        <div class="seg">
          <button class="${debtStrategy === 'avalanche' ? 'on' : ''}" data-act="strategy" data-v="avalanche">Avalanche<span>highest APR first</span></button>
          <button class="${debtStrategy === 'snowball' ? 'on' : ''}" data-act="strategy" data-v="snowball">Snowball<span>smallest balance first</span></button>
        </div>
        <label class="fieldrow">
          <span>Extra payment / month</span>
          <input id="extraInput" type="number" min="0" step="25" value="${debtExtra}" class="mono">
        </label>
        <div class="sub">Your cash flow supports roughly <b class="mono">${fmt(sts.amount || 0)}/mo</b> extra.</div>
      </div>

      ${analysis ? `
      <div class="card">
        <div class="card-title">Payoff plan · ${debtStrategy}</div>
        <div class="statrow tight">
          <div class="stat"><div class="stat-label">DEBT-FREE IN</div><div class="stat-val mono">${analysis.chosen.finished ? timeStr(analysis.chosen.months) : '∞'}</div></div>
          <div class="stat"><div class="stat-label">INTEREST PAID</div><div class="stat-val mono neg">${fmt(analysis.chosen.totalInterest)}</div></div>
          <div class="stat"><div class="stat-label">VS MIN. ONLY</div><div class="stat-val mono pos">${analysis.minOnly.finished ? '−' + fmt(Math.max(0, analysis.minOnly.totalInterest - analysis.chosen.totalInterest)) : 'saves ∞'}</div></div>
        </div>
        <canvas id="payoffchart" class="payoff"></canvas>
        <div class="card-title" style="margin-top:14px">Payoff order</div>
        ${analysis.chosen.order.map((n, i) => {
          const pd = analysis.chosen.perDebt.find(p => p.name === n);
          return `<div class="rowline"><div><b>${i + 1}. ${esc(n)}</b></div><div class="sub mono">${pd && pd.payoffMonth ? 'paid off month ' + pd.payoffMonth : '—'}</div></div>`;
        }).join('')}
      </div>

      <div class="card">
        <div class="card-title">Straight talk</div>
        ${analysis.advice.map(a => `<div class="alert ${a.level}">${esc(a.text)}</div>`).join('')}
      </div>` : ''}`}
    `;

    if (analysis) {
      Charts.payoffLines($('#payoffchart'),
        analysis.chosen.balanceSeries,
        analysis.minOnly.finished ? analysis.minOnly.balanceSeries : null,
        'your plan', 'minimums only');
      const inp = $('#extraInput');
      inp.addEventListener('change', () => { debtExtra = Math.max(0, Number(inp.value) || 0); renderDebt(); });
    }
  }

  /* ================= GOALS ================= */
  function renderGoals() {
    const el = $('#screen-goals');
    const goals = S.state.goals;
    const sts = S.safeToSave();
    const cur = S.monthTotals(S.thisMonthKey());
    const efTargetMonths = S.state.settings.emergencyTargetMonths;

    el.innerHTML = `
      <header class="apphead"><h2>Savings & goals</h2><button class="btn gold small" data-act="goal-add">+ Add goal</button></header>

      <div class="card">
        <div class="card-title">What can I safely save?</div>
        <div class="bigline"><span class="mono gold-t">${fmt(sts.amount || 0)}<small>/mo</small></span></div>
        ${sts.avgIncome ? `
        <div class="sub calcrows">
          <div>avg income <b class="mono">${fmt(sts.avgIncome)}</b></div>
          <div>− essentials <b class="mono">${fmt(sts.avgEssential)}</b></div>
          <div>− lifestyle (kept 60%) <b class="mono">${fmt(sts.avgLifestyle * 0.6)}</b></div>
          <div>− 5% buffer <b class="mono">${fmt(sts.buffer)}</b></div>
        </div>
        <div class="sub">Based on your last 3 months. This assumes you trim lifestyle spending by ~40%, not eliminate it — plans that require zero fun always fail.</div>` : `<div class="sub">${esc(sts.detail || '')}</div>`}
      </div>

      ${goals.map(g => {
        const pct = Math.min(100, g.target ? g.saved / g.target * 100 : 0);
        const monthsSpend = g.isEmergency && cur.spend ? (g.saved / cur.spend) : null;
        return `
        <div class="card">
          <div class="card-title">${esc(g.name)}${g.isEmergency ? ' <span class="tag">emergency</span>' : ''}
            <button class="iconbtn right" data-act="goal-edit" data-id="${g.id}">✎</button>
          </div>
          <div class="progress"><div class="bar ${g.isEmergency ? 'gold' : 'teal'}" style="width:${pct}%"></div></div>
          <div class="rowline">
            <span class="mono">${fmt(g.saved)} of ${fmt(g.target)}</span>
            <span class="sub">${Math.round(pct)}%${monthsSpend !== null ? ` · ${monthsSpend.toFixed(1)} mo of spending (target ${efTargetMonths})` : ''}</span>
          </div>
          <div class="row gap">
            <button class="btn small" data-act="goal-fund" data-id="${g.id}" data-amt="25">+$25</button>
            <button class="btn small" data-act="goal-fund" data-id="${g.id}" data-amt="100">+$100</button>
            <button class="btn small" data-act="goal-fund" data-id="${g.id}" data-amt="custom">+ Custom</button>
          </div>
          ${g.target > g.saved && sts.amount > 0 ? `<div class="sub top6">At ${fmt(Math.min(sts.amount, sts.amount / Math.max(1, goals.length)))}/mo this goal lands in ~${Math.ceil((g.target - g.saved) / Math.max(1, Math.min(sts.amount, sts.amount / Math.max(1, goals.length))))} months.</div>` : ''}
        </div>`;
      }).join('')}

      ${!goals.length ? `<div class="card empty"><h3>Give every dollar a job</h3><p>Start with an emergency fund — even $500 changes how emergencies feel.</p><button class="btn gold" data-act="goal-add">Create emergency fund</button></div>` : ''}
    `;
  }

  /* ================= COACH ================= */
  function renderCoach() {
    const el = $('#screen-coach');
    const hist = S.state.coachHistory;
    const hasBackend = !!S.state.settings.backendUrl.trim();
    el.innerHTML = `
      <header class="apphead"><h2>Financial coach</h2>
        <span class="tag ${hasBackend ? 'on' : ''}">${hasBackend ? 'AI · connected' : 'local mode'}</span>
      </header>
      <div class="chat" id="chatlog">
        ${!hist.length ? `<div class="chatmsg coach">I've read your numbers. Ask me anything — "how do I get out of debt fastest," "can I afford to save more," "what should I cut." I'll be encouraging, but I won't lie to you.${hasBackend ? '' : '\n\n(Local mode: rules-based answers. Connect a backend in Settings for the full AI coach.)'}</div>` : ''}
        ${hist.map(m => `<div class="chatmsg ${m.role === 'user' ? 'user' : 'coach'}">${esc(m.content)}</div>`).join('')}
        <div id="chatspin" class="chatmsg coach hidden">Thinking…</div>
      </div>
      <div class="chatinput">
        <input id="chatbox" type="text" placeholder="Ask about your money…" autocomplete="off">
        <button class="btn gold" data-act="coach-send">Send</button>
      </div>
      <div class="chips">
        <button class="tag" data-act="coach-chip" data-q="What's the fastest way out of my debt?">Debt plan</button>
        <button class="tag" data-act="coach-chip" data-q="How much can I safely save each month?">Safe to save</button>
        <button class="tag" data-act="coach-chip" data-q="Audit my subscriptions">Subscriptions</button>
        <button class="tag" data-act="coach-chip" data-q="Where is my money going this month?">Where's it going?</button>
      </div>
    `;
    const log = $('#chatlog'); log.scrollTop = log.scrollHeight;
    $('#chatbox').addEventListener('keydown', e => { if (e.key === 'Enter') sendCoach(); });
  }

  async function sendCoach(preset) {
    const box = $('#chatbox');
    const msg = (preset || box.value).trim();
    if (!msg) return;
    S.state.coachHistory.push({ role: 'user', content: msg });
    S.save(); // triggers rerender showing the message
    $('#chatspin').classList.remove('hidden');
    const log = $('#chatlog'); log.scrollTop = log.scrollHeight;
    try {
      const reply = await Coach.ask(msg);
      S.state.coachHistory.push({ role: 'assistant', content: reply });
    } catch (err) {
      S.state.coachHistory.push({ role: 'assistant', content: 'I couldn\'t reach the coach backend: ' + err.message + '\n\nCheck the backend URL in Settings, or clear it to use local mode.' });
    }
    S.save();
  }

  /* ================= REPORTS ================= */
  function renderReports() {
    const el = $('#screen-reports');
    const key = S.thisMonthKey();
    const cur = S.monthTotals(key);
    const prev = S.monthTotals(S.shiftMonth(key, -1));
    const recurring = S.recurring();
    const subTotal = recurring.reduce((s, r) => s + r.monthlyCost, 0);
    const changes = [];
    const allCats = new Set([...Object.keys(cur.byCat), ...Object.keys(prev.byCat)]);
    for (const c of allCats) {
      const d = (cur.byCat[c] || 0) - (prev.byCat[c] || 0);
      if (Math.abs(d) >= 40) changes.push({ cat: c, delta: d });
    }
    changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const debts = S.state.debts;

    el.innerHTML = `
      <header class="apphead"><h2>Reports</h2>
        <div class="headbtns">
          <button class="btn small" data-act="export-csv">CSV</button>
          <button class="btn small" data-act="export-json">JSON</button>
        </div>
      </header>

      <div class="card">
        <div class="card-title">This month vs last</div>
        <div class="rowline"><span>Income</span><span class="mono">${fmt(cur.income)} <span class="sub">(${delta(cur.income - prev.income)})</span></span></div>
        <div class="rowline"><span>Spending</span><span class="mono">${fmt(cur.spend)} <span class="sub">(${delta(cur.spend - prev.spend, true)})</span></span></div>
        <div class="rowline"><span>Net</span><span class="mono ${cur.net >= 0 ? 'pos' : 'neg'}">${fmt(cur.net)}</span></div>
      </div>

      <div class="card">
        <div class="card-title">What changed this month</div>
        ${changes.length ? changes.slice(0, 6).map(c => `
          <div class="rowline"><span>${esc(c.cat)}</span><span class="mono ${c.delta > 0 ? 'neg' : 'pos'}">${c.delta > 0 ? '+' : '−'}${fmt(Math.abs(c.delta))}</span></div>
        `).join('') : '<div class="sub">No category moved by more than $40 vs last month.</div>'}
      </div>

      <div class="card">
        <div class="card-title">Subscriptions & recurring · ${fmt(subTotal)}/mo</div>
        ${recurring.length ? recurring.map(r => `
          <div class="rowline"><div><b>${esc(r.merchant)}</b><span class="sub">${r.cadence} · ${esc(r.category)}</span></div><div class="mono">${fmt(r.monthlyCost)}/mo</div></div>
        `).join('') + `<div class="sub top6">Annualized: <b class="mono">${fmt(subTotal * 12)}</b>. Cancel anything you wouldn't re-buy today.</div>` : '<div class="sub">Need at least two months of data to detect recurring charges.</div>'}
      </div>

      ${debts.length ? `
      <div class="card">
        <div class="card-title">Debt progress</div>
        ${debts.map(d => `<div class="rowline"><span>${esc(d.name)}</span><span class="mono neg">${fmt(d.balance)}</span></div>`).join('')}
        <div class="rowline"><b>Total</b><b class="mono neg">${fmt(debts.reduce((s, d) => s + d.balance, 0))}</b></div>
        <div class="sub top6">Update balances monthly (tap a debt in the Debt tab) to see this trend down.</div>
      </div>` : ''}

      <div class="card">
        <div class="card-title">Income / outflow · last 6 months</div>
        <canvas id="repbars" class="bars"></canvas>
      </div>
    `;
    Charts.cashflowBars($('#repbars'), S.monthSeries(6));
  }

  function delta(n, badWhenUp) {
    if (Math.abs(n) < 1) return 'flat';
    const up = n > 0;
    const cls = badWhenUp ? (up ? 'neg' : 'pos') : (up ? 'pos' : 'neg');
    return `<span class="${cls}">${up ? '▲' : '▼'} ${fmt(Math.abs(n))}</span>`;
  }

  /* ================= SETTINGS ================= */
  function renderSettings() {
    const el = $('#screen-settings');
    const st = S.state.settings;
    const accounts = S.state.accounts;
    el.innerHTML = `
      <header class="apphead"><h2>Settings</h2></header>

      <div class="card">
        <div class="card-title">Accounts</div>
        ${accounts.map(a => `
          <button class="txrow" data-act="acct-edit" data-id="${a.id}">
            <div class="txmain"><b>${esc(a.name)}</b><span class="sub">${a.type}${a.plaid ? ' · via Plaid' : ''}</span></div>
            <div class="mono ${a.balance >= 0 ? '' : 'neg'}">${fmt2(a.balance)}</div>
          </button>`).join('')}
        <button class="btn small" data-act="acct-add">+ Add account manually</button>
      </div>

      <div class="card">
        <div class="card-title">Backend (AI coach + Plaid)</div>
        <label class="fieldrow col">
          <span>Cloudflare Worker URL</span>
          <input id="backendUrl" type="url" placeholder="https://pocket-cfo.yourname.workers.dev" value="${esc(st.backendUrl)}">
        </label>
        <button class="btn small" data-act="save-backend">Save backend URL</button>
        <div class="sub top6">Your Claude and Plaid keys live only on the server — never in this page. See the README for the 15-minute setup.</div>
      </div>

      <div class="card">
        <div class="card-title">Bank connection (Plaid)</div>
        <button class="btn gold" data-act="plaid-connect" ${st.backendUrl ? '' : 'disabled'}>Connect a bank account</button>
        <button class="btn small top6" data-act="plaid-sync" ${st.backendUrl ? '' : 'disabled'}>Sync balances & transactions</button>
        <div class="sub top6">${st.backendUrl ? 'Opens Plaid Link. You consent to sharing balances and transactions; nothing is stored beyond what the app needs.' : 'Requires a backend URL above. Manual entry works fully without it.'}</div>
      </div>

      <div class="card">
        <div class="card-title">Data</div>
        <div class="row gap wrap">
          <button class="btn small" data-act="demo">Load demo data</button>
          <button class="btn small" data-act="export-json">Export backup</button>
          <button class="btn small" data-act="import-json">Import backup</button>
          <button class="btn small danger" data-act="reset">Erase everything</button>
        </div>
        <div class="sub top6">All data lives in this browser (localStorage). Export a backup before clearing Safari data or switching devices.</div>
      </div>

      <div class="card">
        <div class="card-title">Home screen app</div>
        <div class="sub">iPhone: open in Safari → Share → <b>Add to Home Screen</b>. It launches full-screen like a native app.</div>
      </div>
    `;
  }

  /* ================= actions ================= */
  function handleAction(act, data) {
    switch (act) {
      case 'demo': if (confirm('Load demo data? This replaces current transactions, debts, and goals.')) S.loadDemo(); break;
      case 'month': moneyMonth = S.shiftMonth(moneyMonth, Number(data.d)); renderMoney(); break;
      case 'filter-cat': moneyFilter.cat = moneyFilter.cat === data.cat ? '' : data.cat; renderMoney(); break;
      case 'tx-add': txModal(); break;
      case 'tx-edit': txModal(S.state.transactions.find(t => t.id === data.id)); break;
      case 'debt-add': debtModal(); break;
      case 'debt-edit': debtModal(S.state.debts.find(d => d.id === data.id)); break;
      case 'strategy': debtStrategy = data.v; renderDebt(); break;
      case 'goal-add': goalModal(); break;
      case 'goal-edit': goalModal(S.state.goals.find(g => g.id === data.id)); break;
      case 'goal-fund': fundGoal(data.id, data.amt); break;
      case 'coach-send': sendCoach(); break;
      case 'coach-chip': sendCoach(data.q); break;
      case 'export-csv': exportCSV(); break;
      case 'export-json': download('pocket-cfo-backup.json', S.exportJSON(), 'application/json'); break;
      case 'import-json': importJSON(); break;
      case 'reset': if (confirm('Erase ALL data? Export a backup first if you care about it.')) S.resetAll(); break;
      case 'save-backend': S.setSetting('backendUrl', $('#backendUrl').value.trim()); toast('Backend saved'); break;
      case 'acct-add': acctModal(); break;
      case 'acct-edit': acctModal(S.state.accounts.find(a => a.id === data.id)); break;
      case 'plaid-connect': plaidConnect(); break;
      case 'plaid-sync': plaidSync(); break;
    }
  }

  function fundGoal(id, amt) {
    const g = S.state.goals.find(x => x.id === id);
    if (!g) return;
    let n = amt === 'custom' ? Number(prompt('Amount to add:', '50')) : Number(amt);
    if (!n || n <= 0) return;
    S.updateGoal(id, { saved: g.saved + n });
    S.addTransaction({ date: new Date().toISOString().slice(0, 10), merchant: 'Transfer to ' + g.name, amount: -n, category: 'Savings', note: '' });
    toast(`Added ${fmt(n)} to ${g.name}`);
  }

  /* ================= modals ================= */
  function modal(html, onOpen) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal">${html}</div>`;
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
    if (onOpen) onOpen(wrap);
    return wrap;
  }

  function txModal(tx) {
    const isEdit = !!tx;
    const catOpts = S.CATEGORIES.map(c => `<option ${tx && tx.category === c ? 'selected' : ''}>${c}</option>`).join('');
    const w = modal(`
      <h3>${isEdit ? 'Edit' : 'Add'} transaction</h3>
      <label class="fieldrow col"><span>Merchant / source</span><input id="m_merchant" value="${esc(tx?.merchant || '')}" placeholder="Pick n Save"></label>
      <div class="row gap">
        <label class="fieldrow col grow"><span>Amount</span><input id="m_amount" type="number" step="0.01" inputmode="decimal" value="${tx ? Math.abs(tx.amount) : ''}" placeholder="0.00" class="mono"></label>
        <label class="fieldrow col"><span>Type</span>
          <select id="m_type"><option value="out" ${!tx || tx.amount < 0 ? 'selected' : ''}>Money out</option><option value="in" ${tx && tx.amount > 0 ? 'selected' : ''}>Money in</option></select></label>
      </div>
      <div class="row gap">
        <label class="fieldrow col grow"><span>Category</span><select id="m_cat">${catOpts}</select></label>
        <label class="fieldrow col"><span>Date</span><input id="m_date" type="date" value="${tx?.date || new Date().toISOString().slice(0, 10)}"></label>
      </div>
      <label class="fieldrow col"><span>Note (optional)</span><input id="m_note" value="${esc(tx?.note || '')}"></label>
      <div class="row gap end">
        ${isEdit ? '<button class="btn danger" id="m_del">Delete</button>' : ''}
        <button class="btn" id="m_cancel">Cancel</button>
        <button class="btn gold" id="m_save">${isEdit ? 'Save changes' : 'Add transaction'}</button>
      </div>
    `);
    w.querySelector('#m_cancel').onclick = () => w.remove();
    if (isEdit) w.querySelector('#m_del').onclick = () => { if (confirm('Delete this transaction?')) { S.deleteTransaction(tx.id); w.remove(); } };
    w.querySelector('#m_save').onclick = () => {
      const amt = Math.abs(Number(w.querySelector('#m_amount').value));
      const merchant = w.querySelector('#m_merchant').value.trim();
      if (!merchant || !amt) { toast('Merchant and amount are required'); return; }
      const rec = {
        merchant,
        amount: w.querySelector('#m_type').value === 'in' ? amt : -amt,
        category: w.querySelector('#m_cat').value,
        date: w.querySelector('#m_date').value,
        note: w.querySelector('#m_note').value.trim()
      };
      if (isEdit) S.updateTransaction(tx.id, rec); else S.addTransaction(rec);
      w.remove();
    };
  }

  function debtModal(d) {
    const isEdit = !!d;
    const w = modal(`
      <h3>${isEdit ? 'Edit' : 'Add'} debt</h3>
      <label class="fieldrow col"><span>Name</span><input id="d_name" value="${esc(d?.name || '')}" placeholder="Visa •• 4417"></label>
      <div class="row gap">
        <label class="fieldrow col grow"><span>Balance</span><input id="d_bal" type="number" step="0.01" inputmode="decimal" value="${d?.balance ?? ''}" class="mono"></label>
        <label class="fieldrow col"><span>APR %</span><input id="d_apr" type="number" step="0.01" inputmode="decimal" value="${d?.apr ?? ''}" class="mono"></label>
      </div>
      <div class="row gap">
        <label class="fieldrow col grow"><span>Minimum payment</span><input id="d_min" type="number" step="1" inputmode="decimal" value="${d?.minPayment ?? ''}" class="mono"></label>
        <label class="fieldrow col"><span>Due day (1–28)</span><input id="d_due" type="number" min="1" max="28" value="${d?.dueDay ?? ''}" class="mono"></label>
      </div>
      <div class="row gap end">
        ${isEdit ? '<button class="btn danger" id="d_del">Delete</button>' : ''}
        <button class="btn" id="d_cancel">Cancel</button>
        <button class="btn gold" id="d_save">${isEdit ? 'Save' : 'Add debt'}</button>
      </div>
    `);
    w.querySelector('#d_cancel').onclick = () => w.remove();
    if (isEdit) w.querySelector('#d_del').onclick = () => { if (confirm('Delete this debt? (Congrats if it\'s paid off.)')) { S.deleteDebt(d.id); w.remove(); } };
    w.querySelector('#d_save').onclick = () => {
      const rec = {
        name: w.querySelector('#d_name').value.trim(),
        balance: Number(w.querySelector('#d_bal').value) || 0,
        apr: Number(w.querySelector('#d_apr').value) || 0,
        minPayment: Number(w.querySelector('#d_min').value) || 0,
        dueDay: Number(w.querySelector('#d_due').value) || null
      };
      if (!rec.name) { toast('Name is required'); return; }
      if (isEdit) S.updateDebt(d.id, rec); else S.addDebt(rec);
      debtExtra = null; // recompute suggestion
      w.remove();
    };
  }

  function goalModal(g) {
    const isEdit = !!g;
    const w = modal(`
      <h3>${isEdit ? 'Edit' : 'Add'} goal</h3>
      <label class="fieldrow col"><span>Name</span><input id="g_name" value="${esc(g?.name || (S.state.goals.some(x => x.isEmergency) ? '' : 'Emergency fund'))}"></label>
      <div class="row gap">
        <label class="fieldrow col grow"><span>Target</span><input id="g_target" type="number" step="1" value="${g?.target ?? ''}" class="mono"></label>
        <label class="fieldrow col grow"><span>Saved so far</span><input id="g_saved" type="number" step="1" value="${g?.saved ?? 0}" class="mono"></label>
      </div>
      <label class="checkrow"><input id="g_em" type="checkbox" ${g?.isEmergency || (!isEdit && !S.state.goals.some(x => x.isEmergency)) ? 'checked' : ''}> This is my emergency fund</label>
      <div class="row gap end">
        ${isEdit ? '<button class="btn danger" id="g_del">Delete</button>' : ''}
        <button class="btn" id="g_cancel">Cancel</button>
        <button class="btn gold" id="g_save">${isEdit ? 'Save' : 'Add goal'}</button>
      </div>
    `);
    w.querySelector('#g_cancel').onclick = () => w.remove();
    if (isEdit) w.querySelector('#g_del').onclick = () => { if (confirm('Delete this goal?')) { S.deleteGoal(g.id); w.remove(); } };
    w.querySelector('#g_save').onclick = () => {
      const rec = {
        name: w.querySelector('#g_name').value.trim(),
        target: Number(w.querySelector('#g_target').value) || 0,
        saved: Number(w.querySelector('#g_saved').value) || 0,
        isEmergency: w.querySelector('#g_em').checked
      };
      if (!rec.name || !rec.target) { toast('Name and target are required'); return; }
      if (rec.isEmergency) S.state.goals.forEach(x => x.isEmergency = false);
      if (isEdit) S.updateGoal(g.id, rec); else S.addGoal(rec);
      w.remove();
    };
  }

  function acctModal(a) {
    const isEdit = !!a;
    const w = modal(`
      <h3>${isEdit ? 'Edit' : 'Add'} account</h3>
      <label class="fieldrow col"><span>Name</span><input id="a_name" value="${esc(a?.name || '')}" placeholder="Checking"></label>
      <div class="row gap">
        <label class="fieldrow col grow"><span>Type</span>
          <select id="a_type">${['checking', 'savings', 'cash', 'credit'].map(t => `<option ${a?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="fieldrow col grow"><span>Balance</span><input id="a_bal" type="number" step="0.01" value="${a?.balance ?? ''}" class="mono"></label>
      </div>
      <div class="sub">Credit card balances should be negative (what you owe).</div>
      <div class="row gap end">
        ${isEdit ? '<button class="btn danger" id="a_del">Delete</button>' : ''}
        <button class="btn" id="a_cancel">Cancel</button>
        <button class="btn gold" id="a_save">Save</button>
      </div>
    `);
    w.querySelector('#a_cancel').onclick = () => w.remove();
    if (isEdit) w.querySelector('#a_del').onclick = () => { if (confirm('Delete this account?')) { S.deleteAccount(a.id); w.remove(); } };
    w.querySelector('#a_save').onclick = () => {
      const rec = { name: w.querySelector('#a_name').value.trim(), type: w.querySelector('#a_type').value, balance: Number(w.querySelector('#a_bal').value) || 0, plaid: a?.plaid || false };
      if (!rec.name) { toast('Name is required'); return; }
      if (isEdit) S.updateAccount(a.id, rec); else S.addAccount(rec);
      w.remove();
    };
  }

  /* ================= Plaid ================= */
  async function plaidConnect() {
    const backend = S.state.settings.backendUrl.trim().replace(/\/$/, '');
    if (!backend) return;
    try {
      await loadScript('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
      const res = await fetch(backend + '/api/plaid/link_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: S.state.settings.userId })
      });
      if (!res.ok) throw new Error('link_token ' + res.status);
      const { link_token } = await res.json();
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (public_token) => {
          const ex = await fetch(backend + '/api/plaid/exchange', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: S.state.settings.userId, public_token })
          });
          if (!ex.ok) { toast('Bank link failed at exchange step'); return; }
          toast('Bank connected — syncing…');
          plaidSync();
        },
        onExit: () => {}
      });
      handler.open();
    } catch (err) {
      toast('Plaid error: ' + err.message);
    }
  }

  async function plaidSync() {
    const backend = S.state.settings.backendUrl.trim().replace(/\/$/, '');
    if (!backend) return;
    try {
      const res = await fetch(backend + '/api/plaid/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: S.state.settings.userId })
      });
      if (!res.ok) throw new Error('sync ' + res.status);
      const data = await res.json();
      // merge accounts
      for (const acct of (data.accounts || [])) {
        const existing = S.state.accounts.find(a => a.plaidId === acct.account_id);
        const bal = acct.type === 'credit' ? -Math.abs(acct.balances.current || 0) : (acct.balances.current || 0);
        if (existing) existing.balance = bal;
        else S.state.accounts.push({ id: S.uid(), plaidId: acct.account_id, name: acct.name, type: acct.type === 'depository' ? (acct.subtype === 'savings' ? 'savings' : 'checking') : acct.type, balance: bal, plaid: true });
      }
      // merge transactions (dedupe on plaid id)
      const seen = new Set(S.state.transactions.map(t => t.plaidId).filter(Boolean));
      let added = 0;
      for (const tx of (data.transactions || [])) {
        if (seen.has(tx.transaction_id)) continue;
        S.state.transactions.push({
          id: S.uid(), plaidId: tx.transaction_id,
          date: tx.date, merchant: tx.merchant_name || tx.name,
          amount: -tx.amount, // Plaid: positive = money out
          category: mapPlaidCategory(tx), note: ''
        });
        added++;
      }
      S.state.transactions.sort((a, b) => b.date.localeCompare(a.date));
      S.save();
      toast(`Synced: ${added} new transaction${added === 1 ? '' : 's'}`);
    } catch (err) {
      toast('Sync error: ' + err.message);
    }
  }

  function mapPlaidCategory(tx) {
    const p = (tx.personal_finance_category?.primary || '').toUpperCase();
    const map = {
      INCOME: 'Income', RENT_AND_UTILITIES: 'Utilities', FOOD_AND_DRINK: 'Dining',
      GROCERIES: 'Groceries', TRANSPORTATION: 'Transport', TRAVEL: 'Entertainment',
      LOAN_PAYMENTS: 'Debt Payment', ENTERTAINMENT: 'Entertainment',
      GENERAL_MERCHANDISE: 'Shopping', MEDICAL: 'Health', PERSONAL_CARE: 'Health',
      GENERAL_SERVICES: 'Other', GOVERNMENT_AND_NON_PROFIT: 'Giving',
      HOME_IMPROVEMENT: 'Housing', BANK_FEES: 'Other', TRANSFER_IN: 'Income', TRANSFER_OUT: 'Savings'
    };
    return map[p] || 'Other';
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('script load failed'));
      document.head.appendChild(s);
    });
  }

  /* ================= exports / misc ================= */
  function exportCSV() {
    const rows = [['date', 'merchant', 'amount', 'category', 'note']];
    for (const t of S.state.transactions) rows.push([t.date, t.merchant, t.amount, t.category, t.note || '']);
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    download('pocket-cfo-transactions.csv', csv, 'text/csv');
  }

  function importJSON() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { try { S.importJSON(r.result); toast('Backup imported'); } catch (e) { toast('Import failed: not a valid backup'); } };
      r.readAsText(f);
    };
    inp.click();
  }

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  function timeStr(months) {
    if (months < 12) return months + ' mo';
    const y = Math.floor(months / 12), m = months % 12;
    return y + 'y' + (m ? ' ' + m + 'mo' : '');
  }
  function ord(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /* ---------------- boot ---------------- */
  nav('home');
})();
