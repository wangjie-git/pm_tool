/* 全局 S、TODAY、常量、模型选择器 —— 拆分自 ui/app.js（来源行 241-242, 256-256, 457-460, 463-524） */

import { daysDiff, todayStr } from './utils.js';

/* 常驻托盘应用会跨天运行：TODAY 必须可刷新，否则次日"今日/逾期/循环重置"全部错位 */
export let TODAY = todayStr();
export const PRI_W = { P0: 0, P1: 1, P2: 2 };
/* ============ 全局状态 ============ */
export const S = { projects: [], tasks: [], ideas: [], decisions: [], meetings: [], contacts: [], cur: null, mode: 'project', view: 'list', search: '', theme: 'light', calMonth: '', todayPid: null,
  smartId: null, timer: null, trashCount: 0, smartViews: [], rules: {}, frogs: { date: '', ids: [] }, shutdownTime: '', qInbox: false,
  dailyGoal: 5, noteDate: TODAY, dnMonth: TODAY.slice(0, 7),
  /* v2.2：卡片密度（compact/cozy）、列表排序、批量选中、键盘行、统计范围、视图可见任务序（键盘导航/批量用） */
  density: 'compact', listSort: 'smart', sel: [], kbId: null, statsRange: '7d', visibleIds: [], ganttCompare: false };
export const RISK_RED = 15; /* 概率×影响 ≥15 标红置顶 */
/* 紧凑卡状态循环顺序（点击状态 chip 依次切换） */
export const STATUS_CYCLE = ['todo', 'doing', 'wait', 'done'];
export const STATUS_LABEL = { todo: '📥 待办', doing: '🔨 进行中', wait: '⏳ 等待', done: '✅ 完成' };

export function curProject() { return S.projects.find(p => p.id == S.cur) || S.projects[0] || null; }
export function projTasks(pid) { return S.tasks.filter(t => t.projectId == pid); }
export function getTask(id) { return S.tasks.find(t => t.id == id); }
export function projNameOf(pid) { if (pid == 0) return '📥 收件箱'; const p = S.projects.find(x => x.id == pid); return p ? p.name : ''; }
export function repeatLabel(rep) { return rep === 'daily' ? '每日' : rep === 'weekly' ? '每周' : rep === 'monthly' ? '每月' : ''; }
/* 距上次更新多少天（无记录则退回创建日期） */
export function staleDays(t) {
  const base = (t.updatedAt || t.createdAt || '').slice(0, 10);
  return base ? -daysDiff(base) : 0;
}
export function riskValue(t) { return (t.risk && t.riskProb > 0 && t.riskImpact > 0) ? (t.riskProb * t.riskImpact) : 0; }
export function isOpen(t) { return t.status !== 'done'; }
export function isOverdue(t) { return isOpen(t) && t.status !== 'wait' && t.due && t.due < TODAY; }
export function subTasksOf(tid) { return S.tasks.filter(t => t.parentId == tid); }
/* 递归收集全部后代 id（带防环）：选父任务/级联删除时用，只排除直接子任务会漏掉孙任务导致成环 */
export function allDescendantIds(tid) {
  const out = [];
  const walk = (pid) => {
    subTasksOf(pid).forEach(s => {
      if (out.indexOf(s.id) >= 0) return;
      out.push(s.id);
      walk(s.id);
    });
  };
  walk(tid);
  return out;
}
/* 检查清单 + 子任务整体进度（GitHub sub-issues roll-up） */
export function rollupSummary(t) {
  const cl = checklistSummary(t);
  const subs = subTasksOf(t.id);
  const done = (cl ? cl.done : 0) + subs.filter(s => s.status === 'done').length;
  const total = (cl ? cl.total : 0) + subs.length;
  return total ? { done: done, total: total, subs: subs.length } : null;
}
export function parseSettings(p) {
  let s = {};
  try { s = JSON.parse(p.settingsJson || '{}') || {}; } catch (e) { s = {}; }
  if (!Array.isArray(s.milestones) || s.milestones.length !== 3) {
    s.milestones = [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }];
  }
  s.report = s.report || (p.name + ' 进度日报');
  if (!s.webhook || typeof s.webhook !== 'object') s.webhook = { type: '', url: '', secret: '' };
  if (typeof s.budgetHours !== 'number' || !(s.budgetHours >= 0)) s.budgetHours = 0;
  if (typeof s.onePager !== 'string') s.onePager = '';
  return s;
}
export function parseChecklist(t) {
  try {
    const arr = JSON.parse(t.checklistJson || '[]');
    if (Array.isArray(arr)) return arr.filter(x => x && typeof x.text === 'string');
  } catch (e) {}
  return [];
}
export function checklistSummary(t) {
  const items = parseChecklist(t);
  if (!items.length) return null;
  return { done: items.filter(x => x.done).length, total: items.length };
}


/* 跨天重置唯一入口：TODAY 的可变绑定只在本模块内重赋值（原 714 行） */
export function setToday(v) { TODAY = v; }

