/* =========================================================
   Pocket CFO — charts.js
   Tiny dependency-free canvas charts, HiDPI-aware.
   ========================================================= */
(function () {
  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  const C = {
    gold: '#E9B44C', income: '#43C79A', spend: '#E5675A',
    line: 'rgba(233,180,76,.9)', grid: 'rgba(140,160,150,.14)',
    muted: '#8CA096', text: '#E9EFEA'
  };

  /* Sparkline (balance over time) */
  function sparkline(canvas, points) {
    const { ctx, w, h } = setup(canvas);
    if (!points || points.length < 2) return;
    const min = Math.min(...points), max = Math.max(...points);
    const pad = 4, range = (max - min) || 1;
    const x = i => pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = v => h - pad - ((v - min) / range) * (h - pad * 2);

    // fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(233,180,76,.22)');
    grad.addColorStop(1, 'rgba(233,180,76,0)');
    ctx.beginPath();
    points.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.lineTo(x(points.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // line
    ctx.beginPath();
    points.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

    // end dot
    ctx.beginPath();
    ctx.arc(x(points.length - 1), y(points[points.length - 1]), 3, 0, Math.PI * 2);
    ctx.fillStyle = C.gold; ctx.fill();
  }

  /* Paired bars: income vs spend per month */
  function cashflowBars(canvas, series) {
    const { ctx, w, h } = setup(canvas);
    if (!series.length) return;
    const max = Math.max(1, ...series.map(m => Math.max(m.income, m.spend)));
    const padB = 18, padT = 6;
    const groupW = w / series.length;
    const barW = Math.min(16, groupW * 0.28);
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    series.forEach((m, i) => {
      const cx = groupW * i + groupW / 2;
      const hIn = (m.income / max) * (h - padB - padT);
      const hSp = (m.spend / max) * (h - padB - padT);
      ctx.fillStyle = C.income;
      roundRect(ctx, cx - barW - 2, h - padB - hIn, barW, hIn, 3); ctx.fill();
      ctx.fillStyle = C.spend;
      roundRect(ctx, cx + 2, h - padB - hSp, barW, hSp, 3); ctx.fill();
      ctx.fillStyle = C.muted;
      const [y, mo] = m.key.split('-');
      ctx.fillText(new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short' }), cx, h - 5);
    });
  }

  /* Donut: spend by category */
  const DONUT_COLORS = ['#E9B44C', '#43C79A', '#E5675A', '#59B7C4', '#B58AE0', '#DE9A5A', '#7FBF6B', '#D9738F', '#8CA096', '#C7C74F'];
  function donut(canvas, entries, centerLabel, centerValue) {
    const { ctx, w, h } = setup(canvas);
    const total = entries.reduce((s, e) => s + e[1], 0);
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6, ir = r * 0.66;
    if (!total) return;
    let a = -Math.PI / 2;
    entries.forEach((e, i) => {
      const frac = e[1] / total;
      const a2 = a + frac * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a + 0.015, a2 - 0.015);
      ctx.arc(cx, cy, ir, a2 - 0.015, a + 0.015, true);
      ctx.closePath();
      ctx.fillStyle = DONUT_COLORS[i % DONUT_COLORS.length];
      ctx.fill();
      a = a2;
    });
    ctx.textAlign = 'center';
    ctx.fillStyle = C.muted; ctx.font = '11px system-ui';
    ctx.fillText(centerLabel, cx, cy - 8);
    ctx.fillStyle = C.text; ctx.font = '600 16px ui-monospace, Menlo, monospace';
    ctx.fillText(centerValue, cx, cy + 12);
  }

  /* Payoff timeline: one or two balance curves over months */
  function payoffLines(canvas, seriesA, seriesB, labelA, labelB) {
    const { ctx, w, h } = setup(canvas);
    const all = seriesB ? seriesA.concat(seriesB) : seriesA;
    const max = Math.max(1, ...all);
    const n = Math.max(seriesA.length, seriesB ? seriesB.length : 0);
    const padL = 6, padR = 6, padT = 8, padB = 20;
    const x = i => padL + (i / Math.max(1, n - 1)) * (w - padL - padR);
    const y = v => padT + (1 - v / max) * (h - padT - padB);

    // grid
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      const gy = padT + (g / 4) * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    }

    function draw(series, color) {
      ctx.beginPath();
      series.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    }
    if (seriesB) draw(seriesB, 'rgba(140,160,150,.55)');
    draw(seriesA, C.gold);

    ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    ctx.fillStyle = C.gold; ctx.fillText('— ' + labelA, padL, h - 6);
    if (seriesB) { ctx.fillStyle = C.muted; ctx.fillText('— ' + labelB, padL + ctx.measureText('— ' + labelA).width + 14, h - 6); }
    ctx.textAlign = 'right'; ctx.fillStyle = C.muted;
    ctx.fillText(`${n} mo`, w - padR, h - 6);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, Math.max(0, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  window.Charts = { sparkline, cashflowBars, donut, payoffLines, DONUT_COLORS };
})();
