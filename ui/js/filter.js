/* 过滤/排序 —— 拆分自 ui/app.js（来源行 1091-1127） */

import { PRI_W, RISK_RED, S, curProject, isOpen, isOverdue, projTasks, riskValue } from './state.js';

export function parseFilter(raw) {
  const f = { kw: '', owner: '', pri: '', risk: false, rep: '' };
  let s = ' ' + (raw || '').trim() + ' ';
  s = s.replace(/@([^\s!@]+)/g, (m, o) => { f.owner = o; return ' '; });
  s = s.replace(/!(P0|P1|P2)/gi, (m, p) => { f.pri = p.toUpperCase(); return ' '; });
  s = s.replace(/#风险/g, () => { f.risk = true; return ' '; });
  s = s.replace(/#(每日|每天|每周|每月)/g, (m, r) => { f.rep = r === '每周' ? 'weekly' : r === '每月' ? 'monthly' : 'daily'; return ' '; });
  f.kw = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return f;
}
export function filteredTasks() {
  const p = curProject(); if (!p) return [];
  const f = parseFilter(S.search);
  let ts = projTasks(p.id);
  if (f.owner) {
    const fo = f.owner.toLowerCase();
    ts = ts.filter(t => (t.owner || '').toLowerCase().indexOf(fo) >= 0);
  }
  if (f.pri) ts = ts.filter(t => (t.pri || 'P1') === f.pri);
  if (f.risk) ts = ts.filter(t => t.risk);
  if (f.rep) ts = ts.filter(t => t.repeat === f.rep);
  if (f.kw) ts = ts.filter(t => (t.title + ' ' + (t.owner || '') + ' ' + (t.note || '')).toLowerCase().indexOf(f.kw) >= 0);
  return ts;
}
export function cmpTask(a, b) {
  const pa = a.sortOrder < 0 ? 0 : 1, pb = b.sortOrder < 0 ? 0 : 1;
  if (pa !== pb) return pa - pb;
  /* 规则：高风险（值≥15）最前，其次逾期置顶（#6/#13） */
  const ra = riskValue(a) >= RISK_RED && isOpen(a) ? 1 : 0, rb = riskValue(b) >= RISK_RED && isOpen(b) ? 1 : 0;
  if (ra !== rb) return rb - ra;
  if (S.rules.overdueTop) {
    const oa = isOverdue(a) ? 1 : 0, ob = isOverdue(b) ? 1 : 0;
    if (oa !== ob) return ob - oa;
  }
  const p1 = PRI_W[a.pri || 'P1'], p2 = PRI_W[b.pri || 'P1'];
  if (p1 !== p2) return p1 - p2;
  if (a.due !== b.due) return a.due < b.due ? -1 : 1;
  return (a.sortOrder || 0) - (b.sortOrder || 0);
}

