/* 统计/蒙特卡洛预测 —— 拆分自 ui/app.js（来源行 375-456, 1738-1950）
 * v2.2 动线3：页头范围切换（近7天/本月/近30天/全部）；条形图固定合理刻度（A7）；
 * 「暂无数据」面板合并为一条引导（降噪）；统计页一键导出 PNG（★☆☆） */

import { invoke, TDialog } from './backend.js';
import { PRI_W, RISK_RED, S, TODAY, curProject, parseSettings, projNameOf, projTasks, riskValue, staleDays } from './state.js';
import { $id, addDays, daysDiff, esc, svgStringToPng, toast } from './utils.js';

export let statsSeq = 0;

/* 统计范围（动线3）：近 7 天 / 本月 / 近 30 天 / 全部，全部图表共用 */
export const STAT_RANGES = [['7d', '近 7 天'], ['month', '本月'], ['30d', '近 30 天'], ['all', '全部']];
export function statRangeStart() {
  if (S.statsRange === 'month') return TODAY.slice(0, 7) + '-01';
  if (S.statsRange === '30d') return addDays(TODAY, -29);
  if (S.statsRange === 'all') return '';
  return addDays(TODAY, -6);
}
export function setStatsRange(r) {
  S.statsRange = r;
  invoke('set_meta', { key: 'statsRange', value: r }).catch(() => {});
  renderStats();
}
/* 完成趋势分桶：与页面图表同口径（全部=按周聚合防柱过密；其余按天），页面与 PNG 导出共用，
 * 避免导出图与页面图不一致（旧实现导出恒为最近 14 天，本月/近30天/全部全对不上） */
export function trendBuckets(done, from) {
  const days = [];
  if (S.statsRange === 'all') {
    const start = from || addDays(TODAY, -119);
    let cur = start;
    while (cur <= TODAY) {
      let n = 0;
      for (let i = 0; i < 7; i++) n += done.filter(t => t.doneAt === addDays(cur, i)).length;
      days.push({ d: cur, n: n });
      cur = addDays(cur, 7);
    }
    if (days.length > 26) days.splice(0, days.length - 26);
  } else {
    let cur = from || addDays(TODAY, -6);
    if (S.statsRange === 'month') cur = TODAY.slice(0, 7) + '-01';
    while (cur <= TODAY) {
      days.push({ d: cur, n: done.filter(t => t.doneAt === cur).length });
      cur = addDays(cur, 1);
    }
  }
  return days;
}

export function pctile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const i = (sortedArr.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (i - lo);
}
/* 项目吞吐量序列：doneAt 按天聚合；<20 条完成时自动降级按周聚合 */
export function throughputSeries(pid) {
  const done = projTasks(pid).filter(t => t.status === 'done' && t.doneAt).map(t => t.doneAt.slice(0, 10)).sort();
  if (!done.length) return { byDay: {}, weekly: false, total: 0, days: [] };
  const start = done[0], end = done[done.length - 1] > TODAY ? done[done.length - 1] : TODAY;
  const byDay = {};
  done.forEach(d => { byDay[d] = (byDay[d] || 0) + 1; });
  const weekly = done.length < 20;
  const days = [];
  let cur = start < addDays(TODAY, -120) ? addDays(TODAY, -120) : start; /* 最多回看 120 天 */
  while (cur <= end) {
    if (weekly) {
      const we = addDays(cur, 6);
      let n = 0;
      for (let i = 0; i < 7; i++) n += byDay[addDays(cur, i)] || 0;
      days.push({ d: cur, n: n });
      cur = addDays(we, 1);
    } else {
      days.push({ d: cur, n: byDay[cur] || 0 });
      cur = addDays(cur, 1);
    }
  }
  return { byDay: byDay, weekly: weekly, total: done.length, days: days };
}
/* 蒙特卡洛：经验重抽样完成量序列，模拟 1000 次得到剩余 N 项的交付日期分布 */
export function monteCarloForecast(pid, remaining) {
  const series = throughputSeries(pid);
  const buckets = series.days.map(x => x.n);
  if (!buckets.length || remaining <= 0 || !series.total || buckets.every(n => n === 0)) return { ok: false, weekly: series.weekly, total: series.total };
  const sims = 1000;
  const horizon = 365;
  const finishDays = [];
  for (let s = 0; s < sims; s++) {
    let acc = 0, day = 0;
    while (acc < remaining && day < horizon) {
      acc += buckets[Math.floor(Math.random() * buckets.length)];
      day++;
    }
    finishDays.push(day);
  }
  finishDays.sort((a, b) => a - b);
  const q = p => {
    const i = Math.min(finishDays.length - 1, Math.max(0, Math.round((finishDays.length - 1) * p)));
    return finishDays[i];
  };
  const unit = series.weekly ? 7 : 1;
  const dateAfter = d => addDays(TODAY, Math.round(d * unit));
  const hist = {};
  finishDays.forEach(d => {
    const key = dateAfter(d);
    hist[key] = (hist[key] || 0) + 1;
  });
  const histArr = Object.keys(hist).sort().map(k => ({ d: k, n: hist[k], p: hist[k] / sims }));
  const res = {
    ok: true, weekly: series.weekly, total: series.total, remaining: remaining, sims: sims,
    p50: dateAfter(q(0.5)), p85: dateAfter(q(0.85)), p95: dateAfter(q(0.95)), hist: histArr,
    basis: '基于最近 ' + buckets.length + (series.weekly ? ' 周' : ' 天') + '吞吐量（共完成 ' + series.total + ' 项）'
  };
  return res;
}
/* SLE：历史 cycle time 的 85 分位（天）；至少 5 条样本才启用 */
export function sleP85Days(pid) {
  const cyc = projTasks(pid)
    .filter(t => t.status === 'done' && t.doingSince && t.doneAt)
    .map(t => Math.max(1, Math.round((new Date(t.doneAt.slice(0, 10)) - new Date(t.doingSince.slice(0, 10))) / 86400000)))
    .sort((a, b) => a - b);
  if (cyc.length < 5) return null;
  return { p85: Math.max(1, Math.round(pctile(cyc, 0.85))), n: cyc.length };
}
/* 进行中任务在制时长（天），供 WIP Aging 与 SLE 对比 */
export function wipAgeDays(t) {
  const base = t.doingSince ? t.doingSince.slice(0, 10) : (t.updatedAt || t.createdAt || '').slice(0, 10);
  if (!base) return 0;
  return Math.max(0, Math.round((new Date(TODAY) - new Date(base)) / 86400000));
}

/* 比例条（A7）：固定合理刻度 max=5 起步，避免「1 条渲染成满宽」的误导 */
function hbarRow(label, count, max, cls, valText) {
  const pct = Math.min(100, Math.round(count / max * 100));
  return '<div class="hbar-row ' + (cls || '') + '"><span class="hl">' + esc(label) + '</span>'
    + '<div class="htrack"><div class="hbar" style="width:' + pct + '%"></div></div>'
    + '<span class="hv">' + (valText != null ? valText : count) + '</span></div>';
}

export async function renderStats() {
  const p = curProject(); if (!p) return;
  const seq = ++statsSeq; /* await 后若已发起更新一次统计渲染，丢弃本次结果避免旧数据覆盖 */
  const from = statRangeStart();
  const ts = projTasks(p.id);
  const open = ts.filter(t => t.status !== 'done');
  const done = ts.filter(t => t.status === 'done');
  const doneInRange = from ? done.filter(t => t.doneAt && t.doneAt >= from) : done;
  const overdue = open.filter(t => t.status !== 'wait' && t.due && t.due < TODAY).length;
  const risks = open.filter(t => t.risk).length;
  const highRisks = open.filter(t => riskValue(t) >= RISK_RED).length;
  const rate = ts.length ? Math.round(done.length / ts.length * 100) : 0;
  const rangeLabel = (STAT_RANGES.find(r => r[0] === S.statsRange) || STAT_RANGES[0])[1];

  /* 页头：范围切换（全部图表共用） + 导出 PNG */
  let h = '<div class="stat-range">' + STAT_RANGES.map(r =>
    '<button class="' + (S.statsRange === r[0] ? 'on' : '') + '" onclick="setStatsRange(\'' + r[0] + '\')">' + r[1] + '</button>').join('')
    + '<span class="flex1"></span>'
    + '<button class="btn teal" style="margin-left:8px;" onclick="exportStatsPng()">📸 导出统计 PNG 发群</button></div>';

  h += '<div class="stat-grid" id="statKpis">'
    + statCard(ts.length, '总事项', 'c-blue') + statCard(done.length, '已完成', 'c-green')
    + statCard(doneInRange.length, rangeLabel + '完成', 'c-teal')
    + statCard(open.filter(t => t.status === 'doing').length, '进行中', 'c-blue')
    + statCard(overdue, '已逾期', 'c-red') + statCard(risks, '开放风险', 'c-red')
    + statCard(highRisks, '高危风险 R≥' + RISK_RED, 'c-red')
    + statCard(rate + '%', '完成率', 'c-green') + '</div>';

  /* 完成趋势：随范围变化（全部=按周聚合，避免柱子过密） */
  const days = trendBuckets(done, from);
  const maxN = Math.max(1, ...days.map(x => x.n));
  h += '<div class="stat-panel"><h3>📈 ' + rangeLabel + '完成趋势（共 ' + doneInRange.length + ' 项）</h3><div class="bars' + (days.length > 16 ? ' small' : '') + '">';
  days.forEach(x => {
    h += '<div class="bar-col"><span class="bv">' + (x.n || '') + '</span>'
      + '<div class="bar" style="height:' + Math.max(3, Math.round(x.n / maxN * 100)) + '%"></div>'
      + '<span class="bl">' + x.d.slice(5) + '</span></div>';
  });
  h += '</div></div>';

  /* 负载/优先级（A7：固定刻度 + 满格说明） */
  const byOwner = {};
  open.forEach(t => { const o = t.owner || '我方'; byOwner[o] = (byOwner[o] || 0) + 1; });
  const owners = Object.keys(byOwner).sort((a, b) => byOwner[b] - byOwner[a]);
  const maxO = Math.max(5, ...owners.map(o => byOwner[o]));
  h += '<div class="stat-panel"><h3>👥 负责人未完成负载</h3>';
  h += owners.length ? '<div class="hbar-scale">满格 = ' + maxO + ' 条（刻度固定，条宽即负载直观对比）</div>'
      + owners.map(o => hbarRow(o, byOwner[o], maxO)).join('')
    : '<div class="empty">暂无未完成任务</div>';
  h += '</div>';

  const priCnt = { P0: 0, P1: 0, P2: 0 };
  open.forEach(t => { const k = PRI_W[t.pri || 'P1'] != null ? t.pri || 'P1' : 'P1'; priCnt[k]++; });
  const maxP = Math.max(5, priCnt.P0, priCnt.P1, priCnt.P2);
  h += '<div class="stat-panel"><h3>🚦 未完成任务优先级分布</h3>';
  h += '<div class="hbar-scale">满格 = ' + maxP + ' 条</div>';
  h += hbarRow('P0', priCnt.P0, maxP, 'red') + hbarRow('P1', priCnt.P1, maxP, 'orange') + hbarRow('P2', priCnt.P2, maxP, '');
  h += '</div>';

  /* 停滞任务：>7 天没更新，供每周回顾清理 */
  const staleList = open.filter(t => staleDays(t) >= 7).sort((a, b) => staleDays(b) - staleDays(a));
  h += '<div class="stat-panel"><h3>💤 停滞任务（7 天以上没动静，每周回顾先过一遍）</h3>';
  h += staleList.length
    ? staleList.slice(0, 8).map(t =>
        '<div class="stale-row" onclick="openTaskEdit(' + t.id + ')"><span class="sd">💤 ' + staleDays(t) + ' 天</span><span class="st">' + esc(t.title) + '</span><span class="so">👤 ' + esc(t.owner || '我方') + ' · ' + esc(t.due) + '</span></div>').join('')
      + (staleList.length > 8 ? '<div class="empty">还有 ' + (staleList.length - 8) + ' 条，建议改期或删除</div>' : '')
    : '<div class="empty">没有停滞任务，很干净 👍</div>';
  h += '</div>';

  h += '<div class="stat-panel"><h3>🧭 状态分布</h3><div>'
    + '<span class="chip2">📥 待办 ' + open.filter(t => t.status === 'todo').length + '</span>'
    + '<span class="chip2">🔨 进行中 ' + open.filter(t => t.status === 'doing').length + '</span>'
    + '<span class="chip2">⏳ 等待 ' + open.filter(t => t.status === 'wait').length + '</span>'
    + '<span class="chip2 good">✅ 已完成 ' + done.length + '</span>'
    + '</div></div>';

  /* 周期统计（#11）：平均处理时长 + 逾期率趋势 */
  const cycDone = done.filter(t => t.doingSince);
  const cycDays = cycDone.map(t => {
    const a = t.doingSince.slice(0, 10);
    const b = (t.doneAt || TODAY).slice(0, 10);
    return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000 * 10) / 10);
  });
  const avgCyc = cycDays.length ? Math.round(cycDays.reduce((s, x) => s + x, 0) / cycDays.length * 10) / 10 : null;
  const openActive = open.filter(t => t.status !== 'wait');
  const overRate = openActive.length ? Math.round(openActive.filter(t => t.due && t.due < TODAY).length / openActive.length * 100) : 0;
  h += '<div class="stat-panel"><h3>⏱ 周期统计（Cycle Time，参考 Linear / Azure DevOps）</h3><div>'
    + '<span class="chip2 cd">平均处理时长：' + (avgCyc != null ? avgCyc + ' 天（' + cycDays.length + ' 条有开始记录）' : '暂无数据：把任务切到「进行中」开始积累') + '</span>'
    + '<span class="chip2 ' + (overRate >= 30 ? 'bad' : '') + '">未完成任务逾期率：' + overRate + '%</span>'
    + '</div>';
  const weeks = [];
  for (let i = 3; i >= 0; i--) {
    const ws = addDays(TODAY, -(i * 7 + 6)), we = addDays(TODAY, -i * 7);
    const wc = done.filter(t => t.doneAt && t.doneAt >= ws && t.doneAt <= we);
    const wover = wc.filter(t => t.due && t.due < t.doneAt).length;
    weeks.push({ label: ws.slice(5) + '~' + we.slice(5), n: wc.length, pct: wc.length ? Math.round(wover / wc.length * 100) : null });
  }
  h += '<div class="bars small">' + weeks.map(w2 =>
    '<div class="bar-col"><span class="bv">' + (w2.pct == null ? '—' : w2.pct + '%') + '</span>'
    + '<div class="bar ' + (w2.pct != null && w2.pct >= 30 ? 'bad' : '') + '" style="height:' + (w2.pct == null ? 3 : Math.max(4, w2.pct)) + '%"></div>'
    + '<span class="bl">' + w2.label + '</span></div>').join('') + '</div>';
  h += '<div class="empty" style="padding:4px 0;">近 4 周每周完成任务的「逾期率」（完成时已过截止日占比）</div></div>';

  /* 本周投入工时（#1，跨项目汇总） */
  try {
    const logs = await invoke('get_time_logs', { since: addDays(TODAY, -6) });
    if (logs && logs.length) {
      const byProj = {};
      logs.forEach(l => {
        const k = l.projectId || 0;
        byProj[k] = (byProj[k] || 0) + (l.minutes || 0);
      });
      const keys = Object.keys(byProj).sort((a, b) => byProj[b] - byProj[a]);
      const totalMin = keys.reduce((s, k) => s + byProj[k], 0);
      const maxM = Math.max(1, ...keys.map(k => byProj[k]));
      h += '<div class="stat-panel"><h3>⏳ 本周投入工时（全部项目共 ' + (totalMin / 60).toFixed(1) + ' 小时 · ' + logs.length + ' 段计时）</h3>';
      h += keys.map(k =>
        '<div class="hbar-row"><span class="hl">' + esc(k === '0' ? '📥 收件箱' : projNameOf(+k) || '（已删项目）') + '</span>'
        + '<div class="htrack"><div class="hbar" style="width:' + Math.round(byProj[k] / maxM * 100) + '%"></div></div>'
        + '<span class="hv">' + (byProj[k] / 60).toFixed(1) + 'h</span></div>').join('');
      h += '</div>';
    }
  } catch (e) {}

  /* ---------- 包1：吞吐量柱状图（#2） ---------- */
  const thr = throughputSeries(p.id);
  const openCnt = open.filter(t => t.status !== 'wait').length;
  if (thr.days.length) {
    const win = thr.days.slice(-24);
    const maxT = Math.max(1, ...win.map(x => x.n));
    const sorted = win.map(x => x.n).slice().sort((a, b) => a - b);
    const median = pctile(sorted, 0.5) || 0;
    h += '<div class="stat-panel"><h3>🚚 吞吐量（Nave）· ' + (thr.weekly ? '按周聚合（完成数 &lt; 20 自动降级口径）' : '按天聚合') + '</h3><div class="bars">';
    h += win.map(x =>
      '<div class="bar-col"><span class="bv">' + (x.n || '') + '</span>'
      + '<div class="bar" style="height:' + Math.max(3, Math.round(x.n / maxT * 100)) + '%"></div>'
      + '<span class="bl">' + x.d.slice(5) + '</span></div>').join('');
    h += '</div><div class="empty" style="padding:4px 0;">每周/每天完成量 · 中位数 <b>' + median + '</b> 项 · 历史共完成 ' + thr.total + ' 项</div></div>';
  }

  /* ---------- 降噪（动线3）：交付预测 / SLE / 预算 无数据的合并为一条引导，有数据的才各占一屏 ---------- */
  const stt = parseSettings(p);
  const fcReady = thr.total >= 3;
  const sleReady = !!sleP85Days(p.id);
  const budgetReady = stt.budgetHours > 0;
  const missing = [];
  if (!fcReady) missing.push('交付预测（需 ≥3 条已完成任务积累吞吐量）');
  if (!sleReady) missing.push('SLE 分位（需 ≥5 条有「进行中→完成」记录的任务）');
  if (!budgetReady) missing.push('工时预算（点项目名 → 设置里填写预算小时数）');
  if (missing.length) {
    h += '<div class="stat-panel stat-guide"><h3>🧭 还有 ' + missing.length + ' 张图没数据，补齐即可解锁</h3><div>'
      + missing.map(m => '<span class="chip2">' + esc(m) + '</span>').join('') + '</div></div>';
  }

  if (fcReady) {
    h += '<div class="stat-panel"><h3>🎯 交付预测（蒙特卡洛 · Vacanti/Magennis）——回答「哪天交付」</h3>';
    h += '<div class="fc-row"><label style="margin:0;">剩余任务数</label><input type="number" id="fc-remaining" min="1" value="' + Math.max(1, openCnt) + '" style="width:90px;">'
      + '<button class="btn blue" onclick="runForecast()">🔮 预测</button><span id="fc-basis" class="hint"></span></div>'
      + '<div id="fc-result">' + forecastHtml(monteCarloForecast(p.id, Math.max(1, openCnt)), openCnt) + '</div>';
    h += '</div>';
  }

  if (budgetReady) {
    try {
      const logs = await invoke('get_time_logs', { since: '2000-01-01' }) || [];
      const used = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
      const pct = Math.min(100, Math.round(used / stt.budgetHours * 100));
      const wk = addDays(TODAY, -6);
      const burnWk = logs.filter(l => l.projectId == p.id && l.date >= wk).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
      const remain = Math.max(0, stt.budgetHours - used);
      const weeksLeft = burnWk > 0.05 ? (remain / burnWk) : null;
      h += '<div class="stat-panel"><h3>🧮 工时预算（Toggl Alerts）——回答「花了多少」</h3>'
        + '<div class="hbar-row"><span class="hl">已用 / 预算</span><div class="htrack"><div class="hbar ' + (pct >= 100 ? 'red' : pct >= 80 ? 'orange' : '') + '" style="width:' + pct + '%"></div></div><span class="hv">' + pct + '%</span></div>'
        + '<div class="chips-line"><span class="chip2 ' + (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'good') + '">⏳ ' + used.toFixed(1) + ' / ' + stt.budgetHours + ' 小时</span>'
        + '<span class="chip2">近 7 天燃烧 ' + burnWk.toFixed(1) + 'h/周</span>'
        + '<span class="chip2 ' + (weeksLeft != null && weeksLeft < 2 ? 'bad' : '') + '">' + (weeksLeft != null ? '照此速率约 ' + (weeksLeft < 0.2 ? '本周内' : weeksLeft.toFixed(1) + ' 周') + '用完剩余 ' + remain.toFixed(1) + 'h' : '近 7 天无投入') + '</span></div>'
        + '<div class="empty" style="padding:2px 0;">告警阈值 80%/100%：触发时走系统托盘通知' + (stt.webhook && stt.webhook.url ? ' + 群推送' : '') + '；日报自动附燃烧率。</div></div>';
    } catch (e) {}
  }

  if (sleReady) {
    const sle = sleP85Days(p.id);
    h += '<div class="stat-panel"><h3>📏 SLE 分位阈值（ActionableAgile）</h3>';
    h += '<div class="chips-line"><span class="chip2 cd">85% 的任务 ≤ ' + sle.p85 + ' 天完成</span><span class="chip2">样本 ' + sle.n + ' 条（有「进行中→完成」记录的任务）</span><span class="chip2">看板里 WIP 超过 ' + sle.p85 + ' 天的卡片标红</span></div>';
    h += '</div>';
  }

  if (seq !== statsSeq) return; /* 中途有 await，若期间已再次触发渲染则丢弃本次结果 */
  $id('viewStats').innerHTML = h;
}

/* ---------- 统计导出整页 PNG（★☆☆）：把 KPI/趋势/负载 拼成一张 SVG 海报，复用甘特导出管线 ---------- */
export async function exportStatsPng() {
  const p = curProject(); if (!p) return;
  const from = statRangeStart();
  const ts = projTasks(p.id);
  const done = ts.filter(t => t.status === 'done');
  const open = ts.filter(t => t.status !== 'done');
  const doneInRange = from ? done.filter(t => t.doneAt && t.doneAt >= from) : done;
  const overdue = open.filter(t => t.status !== 'wait' && t.due && t.due < TODAY).length;
  const rangeLabel = (STAT_RANGES.find(r => r[0] === S.statsRange) || STAT_RANGES[0])[1];
  const W = 900;
  const rows = [];
  const byOwner = {};
  open.forEach(t => { const o = t.owner || '我方'; byOwner[o] = (byOwner[o] || 0) + 1; });
  const owners = Object.keys(byOwner).sort((a, b) => byOwner[b] - byOwner[a]).slice(0, 6);
  const maxO = Math.max(5, ...owners.map(o => byOwner[o]), 1);
  const trend = trendBuckets(done, from); /* 与页面同口径：本月/近30天/全部 导出图与页面一致 */
  const maxT = Math.max(1, ...trend.map(x => x.n));
  const H = 420;
  const sv = [];
  sv.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" font-family="Segoe UI,Microsoft YaHei,sans-serif">');
  sv.push('<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>');
  sv.push('<text x="32" y="46" font-size="22" font-weight="bold" fill="#1b2231">' + esc(p.name) + ' · 统计速览</text>');
  sv.push('<text x="32" y="70" font-size="12" fill="#77809a">' + rangeLabel + ' · 生成于 ' + TODAY + '</text>');
  /* KPI 行 */
  const kpis = [['总事项', ts.length], [rangeLabel + '完成', doneInRange.length], ['进行中', open.filter(t => t.status === 'doing').length], ['已逾期', overdue], ['完成率', (ts.length ? Math.round(done.length / ts.length * 100) : 0) + '%']];
  kpis.forEach((k, i) => {
    const x = 32 + i * 168;
    sv.push('<rect x="' + x + '" y="90" width="150" height="64" rx="10" fill="#f2f4f8"/>');
    sv.push('<text x="' + (x + 14) + '" y="122" font-size="22" font-weight="bold" fill="#4c6ef5">' + k[1] + '</text>');
    sv.push('<text x="' + (x + 14) + '" y="142" font-size="11" fill="#77809a">' + esc(k[0]) + '</text>');
  });
  /* 趋势条 */
  sv.push('<text x="32" y="196" font-size="13" font-weight="bold" fill="#1b2231">' + rangeLabel + '完成趋势</text>');
  trend.forEach((x, i) => {
    const bw = Math.min(46, (W - 96) / trend.length - 6);
    const bx = 40 + i * ((W - 96) / trend.length);
    const bh = Math.max(3, Math.round(x.n / maxT * 90));
    sv.push('<rect x="' + bx + '" y="' + (300 - bh) + '" width="' + bw + '" height="' + bh + '" rx="4" fill="#4c6ef5"/>');
    if (x.n) sv.push('<text x="' + (bx + bw / 2) + '" y="' + (294 - bh) + '" font-size="10" text-anchor="middle" fill="#77809a">' + x.n + '</text>');
    sv.push('<text x="' + (bx + bw / 2) + '" y="314" font-size="9" text-anchor="middle" fill="#77809a">' + x.d.slice(5) + '</text>');
  });
  /* 负载条 */
  sv.push('<text x="32" y="352" font-size="13" font-weight="bold" fill="#1b2231">未完成负载</text>');
  owners.forEach((o, i) => {
    const bx = 40 + i * 140;
    const bw = Math.round(byOwner[o] / maxO * 100);
    sv.push('<rect x="' + bx + '" y="366" width="100" height="10" rx="5" fill="#e5e9f1"/>');
    sv.push('<rect x="' + bx + '" y="366" width="' + Math.max(4, bw) + '" height="10" rx="5" fill="#10a8a0"/>');
    sv.push('<text x="' + bx + '" y="392" font-size="10" fill="#1b2231">' + esc(o) + ' ' + byOwner[o] + '</text>');
  });
  sv.push('<text x="32" y="' + (H - 12) + '" font-size="10" fill="#77809a">由 PM 待办助手导出 · 数据存于本机</text>');
  sv.push('</svg>');
  try {
    const dataUrl = await svgStringToPng(sv.join(''), W, H);
    const path = await TDialog().save({
      title: '导出统计 PNG',
      defaultPath: p.name + '-统计-' + TODAY + '.png',
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (!path) { toast('已取消导出', 'info'); return; }
    await invoke('save_binary_file', { path: path, dataBase64: dataUrl.split(',')[1] });
    toast('📸 已导出：' + path);
  } catch (e) { toast('导出统计 PNG 失败：' + (e && e.message || e), 'err'); }
}
/* 预测结果：三行置信表 + 直方图 + 可转发群的话术 */
export function forecastHtml(fc, openCnt) {
  if (!fc.ok) return '<div class="empty">暂无可用吞吐量数据。</div>';
  const level = fc.weekly ? ['50%', '85%'] : ['50%', '85%', '95%'];
  const dates = fc.weekly ? [fc.p50, fc.p85] : [fc.p50, fc.p85, fc.p95];
  let h = '<table class="fc-table"><thead><tr><th>置信度</th><th>完成日期</th></tr></thead><tbody>';
  dates.forEach((d, i) => {
    h += '<tr><td>' + level[i] + '</td><td><b>' + d + '</b>（' + daysDiff(d) + ' 天后）</td></tr>';
  });
  h += '</tbody></table>';
  const hist = fc.hist.slice(-30);
  if (hist.length > 1) {
    const maxP = Math.max(0.0001, ...hist.map(x => x.p));
    h += '<div class="bars small" style="height:70px;margin-top:10px;">' + hist.map(x =>
      '<div class="bar-col" title="' + x.d + '：' + Math.round(x.p * 100) + '%"><div class="bar" style="height:' + Math.max(4, Math.round(x.p / maxP * 100)) + '%"></div>'
      + '<span class="bl">' + x.d.slice(5) + '</span></div>').join('') + '</div>';
  }
  const talk = '【' + (curProject() ? curProject().name : '') + ' 交付预测】剩余 ' + fc.remaining + ' 项任务：'
    + level.map((lv, i) => lv + ' 可能性于 ' + dates[i] + ' 前全部完成').join('；')
    + '。（' + fc.basis + '，蒙特卡洛模拟 ' + fc.sims + ' 次）';
  h += '<div class="fc-talk"><span id="fc-talk-text">' + esc(talk) + '</span><button class="btn ghost" style="margin-left:8px;flex:none;" onclick="copyText($id(\'fc-talk-text\').textContent, \'话术已复制，可粘贴进群\')">复制话术</button></div>';
  h += '<div class="empty" style="padding:2px 0;">' + esc(fc.basis) + '</div>';
  return h;
}
export async function runForecast() {
  const p = curProject(); if (!p) return;
  const inp = $id('fc-remaining');
  const n = Math.max(1, +(inp ? inp.value : 1) || 1);
  const fc = monteCarloForecast(p.id, n);
  const box = $id('fc-result');
  if (box) box.innerHTML = forecastHtml(fc, n);
}
export function statCard(v, label, color) {
  return '<div class="stat-card ' + color + '"><div class="sv">' + v + '</div><div class="sl">' + label + '</div></div>';
}

/* ---------- 日历视图（当前项目月历，看截止日扎堆） ---------- */
