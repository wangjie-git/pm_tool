/* PM 待办助手 v2.1 —— 前端逻辑
 * 桌面模式：通过 Tauri invoke 调用 Rust + SQLite
 * 浏览器模式（直接打开 index.html）：用 localStorage 模拟后端，便于开发预览
 */
'use strict';

/* ============ 后端桥接 ============ */
function makeMockBackend() {
  const KEY = 'pm_mock_db_v2';
  const now = new Date();
  const T = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  let db = null;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
  if (!db || !Array.isArray(db.projects)) {
    db = {
      projects: [{ id: 1, name: '示例项目', archived: false, createdAt: T,
        settingsJson: JSON.stringify({ report: '示例项目 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] }) }],
      tasks: [{ id: 1, projectId: 1, title: '每天早上生成进度日报并发送（点顶部【日报】一键生成复制）', due: T, owner: '我方',
        pri: 'P1', status: 'todo', doneAt: '', risk: false, repeat: 'daily', note: '浏览器预览模式，数据存于 localStorage', createdAt: T, sortOrder: 1, checklistJson: '[]' }],
      meta: {}, nextId: 100, ideas: [], timeLogs: [], trash: [], trashNext: 1
    };
    localStorage.setItem(KEY, JSON.stringify(db));
  }
  if (!db.ideas) db.ideas = [];
  if (!db.timeLogs) db.timeLogs = [];
  if (!db.trash) db.trash = [];
  if (!db.trashNext) db.trashNext = 1;
  if (!db.decisions) db.decisions = [];
  if (!db.meetings) db.meetings = [];
  if (!db.contacts) db.contacts = [];
  if (!db.nextId) db.nextId = 100;
  const persist = () => localStorage.setItem(KEY, JSON.stringify(db));
  const clone = x => JSON.parse(JSON.stringify(x));
  return async (cmd, args) => {
    args = args || {};
    switch (cmd) {
      case 'load_app':
        return { projects: clone(db.projects), tasks: clone(db.tasks), ideas: clone(db.ideas), timeLogs: [],
          decisions: clone(db.decisions), meetings: clone(db.meetings), contacts: clone(db.contacts) };
      case 'upsert_task': {
        const t = clone(args.task);
        if (!t.updatedAt) t.updatedAt = nowMinStr();
        if (t.id > 0) {
          const i = db.tasks.findIndex(x => x.id === t.id);
          if (i >= 0) db.tasks[i] = t;
        } else {
          t.id = db.nextId++;
          const max = db.tasks.filter(x => x.projectId === t.projectId).reduce((m, x) => Math.max(m, x.sortOrder || 0), 0);
          t.sortOrder = max + 1;
          db.tasks.push(t);
        }
        persist(); return clone(t);
      }
      case 'delete_task': {
        const t = db.tasks.find(x => x.id === args.id);
        if (!t) return 0;
        const trashId = db.trashNext++;
        db.trash.push({ id: trashId, kind: 'task', payload: clone(t), summary: t.title, deletedAt: nowMinStr() });
        db.tasks = db.tasks.filter(x => x.id !== args.id); persist(); return trashId;
      }
      case 'upsert_project': {
        const p = clone(args.project);
        if (p.id > 0) {
          const i = db.projects.findIndex(x => x.id === p.id);
          if (i >= 0) db.projects[i] = p;
        } else {
          p.id = db.nextId++;
          if (!p.createdAt) p.createdAt = T;
          db.projects.push(p);
        }
        persist(); return clone(p);
      }
      case 'delete_project': {
        const p = db.projects.find(x => x.id === args.id);
        if (!p) return 0;
        const pts = db.tasks.filter(x => x.projectId === args.id);
        const trashId = db.trashNext++;
        db.trash.push({ id: trashId, kind: 'project', payload: { project: clone(p), tasks: clone(pts) }, summary: p.name + '（含 ' + pts.length + ' 条事项）', deletedAt: nowMinStr() });
        db.projects = db.projects.filter(x => x.id !== args.id);
        db.tasks = db.tasks.filter(x => x.projectId !== args.id); persist(); return trashId;
      }
      case 'list_deleted':
        return clone(db.trash).sort((a, b) => b.id - a.id);
      case 'restore_deleted': {
        const i = db.trash.findIndex(x => x.id === args.id);
        if (i < 0) throw new Error('回收站里没有这条记录');
        const it = db.trash[i];
        if (it.kind === 'project') {
          let pid = it.payload.project.id;
          if (db.projects.some(x => x.id === pid)) { pid = db.nextId++; it.payload.project.id = pid; }
          it.payload.project.id = pid;
          db.projects.push(it.payload.project);
          it.payload.tasks.forEach(t => {
            if (db.tasks.some(x => x.id === t.id)) t.id = db.nextId++;
            t.projectId = pid;
            db.tasks.push(t);
          });
        } else {
          const t = it.payload;
          if (db.tasks.some(x => x.id === t.id)) t.id = db.nextId++;
          db.tasks.push(t);
        }
        db.trash.splice(i, 1); persist(); return null;
      }
      case 'purge_deleted':
        if (args.id) db.trash = db.trash.filter(x => x.id !== args.id);
        else db.trash = []; persist(); return null;
      case 'get_timer': {
        const tid = +db.meta.timerTaskId || 0, ts = +db.meta.timerStart || 0;
        return (tid > 0 && ts > 0) ? { taskId: tid, startedAt: ts } : null;
      }
      case 'start_timer':
        db.meta.timerTaskId = String(args.taskId);
        db.meta.timerStart = String(Math.floor(Date.now() / 1000)); persist(); return null;
      case 'stop_timer': {
        const tid = +db.meta.timerTaskId || 0, ts = +db.meta.timerStart || 0;
        if (!(tid > 0 && ts > 0)) return 0;
        const mins = Math.max(1, Math.round((Date.now() / 1000 - ts) / 60));
        const t = db.tasks.find(x => x.id === tid);
        db.timeLogs.push({ id: db.nextId++, taskId: tid, projectId: t ? t.projectId : 0, date: todayStr(), minutes: mins, note: '' });
        delete db.meta.timerTaskId; delete db.meta.timerStart; persist(); return mins;
      }
      case 'get_time_logs':
        return clone(db.timeLogs.filter(l => l.date >= (args.since || '')));
      case 'send_webhook':
        throw new Error('浏览器预览模式不支持发送到群，请在桌面版使用');
      case 'ai_chat':
        throw new Error('浏览器预览模式不支持 AI 润色，请在桌面版使用');
      case 'ai_list_models':
        throw new Error('浏览器预览模式不支持拉取模型列表，请在桌面版使用');
      case 'list_ideas':
        return clone(db.ideas);
      case 'upsert_idea': {
        const it = clone(args.idea);
        it.value = Math.max(1, Math.min(10, +it.value || 3));
        it.effort = Math.max(1, Math.min(10, +it.effort || 3));
        if (it.id > 0) {
          const i = db.ideas.findIndex(x => x.id === it.id);
          if (i >= 0) db.ideas[i] = it;
        } else {
          it.id = db.nextId++;
          if (!it.createdAt) it.createdAt = T;
          db.ideas.push(it);
        }
        persist(); return clone(it);
      }
      case 'delete_idea':
        db.ideas = db.ideas.filter(x => x.id !== args.id); persist(); return null;
      case 'import_data':
        db.projects = clone(args.data.projects); db.tasks = clone(args.data.tasks);
        db.ideas = clone(args.data.ideas || []); persist(); return null;
      case 'list_decisions':
        return clone(args.projectId ? db.decisions.filter(d => d.projectId == args.projectId) : db.decisions);
      case 'upsert_decision': {
        const d = clone(args.d);
        if (!d.status) d.status = '生效中';
        if (!d.date) d.date = T;
        if (d.id > 0) {
          const i = db.decisions.findIndex(x => x.id === d.id);
          if (i >= 0) db.decisions[i] = d;
        } else {
          d.id = db.nextId++;
          if (!d.createdAt) d.createdAt = nowMinStr();
          db.decisions.unshift(d);
        }
        persist(); return clone(d);
      }
      case 'delete_decision':
        db.decisions = db.decisions.filter(x => x.id !== args.id); persist(); return null;
      case 'list_meetings':
        return clone(db.meetings);
      case 'upsert_meeting': {
        const m = clone(args.m);
        if (!m.itemsJson || m.itemsJson === '') m.itemsJson = '[]';
        if (!m.date) m.date = T;
        if (m.id > 0) {
          const i = db.meetings.findIndex(x => x.id === m.id);
          if (i >= 0) db.meetings[i] = m;
        } else {
          m.id = db.nextId++;
          if (!m.createdAt) m.createdAt = nowMinStr();
          db.meetings.unshift(m);
        }
        persist(); return clone(m);
      }
      case 'delete_meeting':
        db.meetings = db.meetings.filter(x => x.id !== args.id); persist(); return null;
      case 'list_contacts':
        return clone(db.contacts);
      case 'upsert_contact': {
        const c = clone(args.c);
        c.followupDays = Math.max(1, Math.min(365, +c.followupDays || 14));
        if (c.id > 0) {
          const i = db.contacts.findIndex(x => x.id === c.id);
          if (i >= 0) db.contacts[i] = c;
        } else {
          c.id = db.nextId++;
          if (!c.createdAt) c.createdAt = T;
          if (!c.lastContact) c.lastContact = T;
          db.contacts.push(c);
        }
        persist(); return clone(c);
      }
      case 'delete_contact':
        db.contacts = db.contacts.filter(x => x.id !== args.id); persist(); return null;
      case 'notify_desktop': return null;
      case 'taskbar_progress': return null;
      case 'autostart_status': return false;
      case 'autostart_set': return !!args.enable;
      case 'quick_hide': return null;
      case 'set_quick_hotkey': return null;
      case 'export_project_md': return args.dir || '';
      case 'export_xlsx': return null;
      case 'save_binary_file': return null;
      case 'get_meta':
        return (args.key in db.meta) ? db.meta[args.key] : null;
      case 'set_meta':
        db.meta[args.key] = args.value; persist(); return null;
      case 'backup_now':
        return null;
      default:
        throw new Error('浏览器预览模式不支持：' + cmd);
    }
  };
}

if (!window.__TAURI__) {
  const mock = makeMockBackend();
  window.__TAURI__ = {
    core: { invoke: mock },
    dialog: { save: async () => null, open: async () => null }
  };
}
const invoke = window.__TAURI__.core.invoke;
const TDialog = () => window.__TAURI__.dialog;

/* ============ 工具 ============ */
function $id(x) { return document.getElementById(x); }
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
/* 常驻托盘应用会跨天运行：TODAY 必须可刷新，否则次日"今日/逾期/循环重置"全部错位 */
let TODAY = todayStr();
function nowMinStr() { const d = new Date(); return todayStr() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function addDays(s, n) { const p = s.split('-'); const d = new Date(+p[0], +p[1] - 1, +p[2]); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
/* 月份加法：超出当月天数自动取月末（1-31 → 2-28/2-29） */
function addMonths(s, n) {
  const p = s.split('-');
  let y = +p[0], m = +p[1] - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  const dim = new Date(y, m + 1, 0).getDate();
  const d = Math.min(+p[2], dim);
  return y + '-' + pad(m + 1) + '-' + pad(d);
}
function esc(s) { return (s == null ? '' : '' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function daysDiff(d) { return Math.round((new Date(d) - new Date(TODAY)) / 86400000); }
const PRI_W = { P0: 0, P1: 1, P2: 2 };

function toast(msg, type, action) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'ok');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.onclick = () => { action.onClick(); el.remove(); };
    el.appendChild(btn);
  }
  $id('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, action ? 6500 : 2600);
}
function toastErr(context, e) { console.error(context, e); toast(context + '：' + (e && e.message || e), 'err'); }

/* ============ 轻量 Markdown 渲染（包4 #13）+ [[反链]]（#14） ============
 * 只覆盖备注/决策/笔记真正用到的子集：标题、列表、引用、粗斜体、行内码、代码块、分隔线、[[链接]]、@提及。
 * 输入先整体 HTML 转义再打标记，天然防注入。 */
function mdInline(s) {
  let out = esc(s);
  out = out.replace(/\[\[([^\[\]]+)\]\]/g, (m, t) => '<a class="wikilink" data-w="' + t + '" title="跳转到「' + t + '">' + t + '</a>');
  out = out.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  return out;
}
function mdRender(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
  let html = '', inCode = false, inList = false, listTag = 'ul', para = [];
  const flushPara = () => { if (para.length) { html += '<p>' + mdInline(para.join(' ')) + '</p>'; para = []; } };
  const closeList = () => { if (inList) { html += '</' + listTag + '>'; inList = false; } };
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      flushPara(); closeList();
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); html += '<h4 class="mdh">' + mdInline(h[2]) + '</h4>'; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ol ? 'ol' : 'ul';
      if (inList && listTag !== tag) closeList();
      if (!inList) { html += '<' + tag + '>'; inList = true; listTag = tag; }
      html += '<li>' + mdInline((ul || ol)[1]) + '</li>';
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); closeList(); html += '<blockquote>' + mdInline(q[1]) + '</blockquote>'; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); closeList(); html += '<hr>'; continue; }
    para.push(line.trim());
  }
  flushPara(); closeList();
  if (inCode) html += '</code></pre>';
  return html || '<p class="dim2">（空）</p>';
}
/* [[反链]] 索引：扫全库找提到 title 的地方（单机数据量小，动态扫描免维护同步表） */
function extractWikilinks(text) {
  const out = [];
  const s = String(text || '');
  const re = /\[\[([^\[\]]+)\]\]/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[1].trim();
    if (t && out.indexOf(t) < 0) out.push(t);
  }
  return out;
}
function findTaskByTitle(title) {
  return S.tasks.find(t => t.title === title) || null;
}
/* 谁/哪些记录提到了 title：任务备注、决策、会议、每日笔记、项目一页纸 */
function backlinksOf(title) {
  const out = [];
  const hit = (text) => extractWikilinks(text).some(x => x === title) || new RegExp('(^|[^\\w])@' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])').test(String(text || ''));
  S.tasks.forEach(t => {
    if (t.title === title) return;
    if (hit(t.note)) out.push({ kind: 'task', id: t.id, label: t.title, sub: '任务 · ' + projNameOf(t.projectId) });
  });
  S.decisions.forEach(d => {
    if (d.title === title) return;
    if (hit([d.background, d.options, d.decision, d.reason].join('\n'))) out.push({ kind: 'decision', id: d.id, label: d.title, sub: '决策 · ' + (d.date || '') });
  });
  S.meetings.forEach(mm => {
    if (hit([mm.conclusion, (mm.itemsJson || '')].join('\n'))) out.push({ kind: 'meeting', id: mm.id, label: mm.title, sub: '会议 · ' + (mm.date || '') });
  });
  S.projects.forEach(p => {
    const s = parseSettings(p);
    if (s.onePager && hit(s.onePager)) out.push({ kind: 'project', id: p.id, label: p.name + ' 一页纸', sub: '项目档案' });
  });
  return out.slice(0, 12);
}
/* [[链接]] / @提及 的点击代理：优先跳任务，其次决策，最后搜命令面板 */
function handleWikilinkClick(e) {
  const a = e.target.closest ? e.target.closest('.wikilink') : null;
  if (!a) return;
  e.preventDefault();
  const t = a.getAttribute('data-w');
  if (!t) return;
  const task = findTaskByTitle(t);
  if (task) { S.cur = '' + task.projectId; S.mode = 'project'; render(); openTaskEdit(task.id); return; }
  const d = S.decisions.find(x => x.title === t);
  if (d) { if (d.projectId && S.projects.some(p => p.id == d.projectId)) switchProject(d.projectId); S.mode = 'project'; S.view = 'decisions'; render(); openDecisionModal(d.id); return; }
  openPalette();
  $id('pal-input').value = t;
  renderPalette(t);
}

/* ============ 包1 统计工具：吞吐量 / 蒙特卡洛 / SLE ============ */
function pctile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const i = (sortedArr.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (i - lo);
}
/* 项目吞吐量序列：doneAt 按天聚合；<20 条完成时自动降级按周聚合 */
function throughputSeries(pid) {
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
function monteCarloForecast(pid, remaining) {
  const series = throughputSeries(pid);
  const buckets = series.days.map(x => x.n);
  if (!buckets.length || remaining <= 0) return { ok: false, weekly: series.weekly, total: series.total };
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
function sleP85Days(pid) {
  const cyc = projTasks(pid)
    .filter(t => t.status === 'done' && t.doingSince && t.doneAt)
    .map(t => Math.max(1, Math.round((new Date(t.doneAt.slice(0, 10)) - new Date(t.doingSince.slice(0, 10))) / 86400000)))
    .sort((a, b) => a - b);
  if (cyc.length < 5) return null;
  return { p85: Math.max(1, Math.round(pctile(cyc, 0.85))), n: cyc.length };
}
/* 进行中任务在制时长（天），供 WIP Aging 与 SLE 对比 */
function wipAgeDays(t) {
  const base = t.doingSince ? t.doingSince.slice(0, 10) : (t.updatedAt || t.createdAt || '').slice(0, 10);
  if (!base) return 0;
  return Math.max(0, Math.round((new Date(TODAY) - new Date(base)) / 86400000));
}

/* ============ 全局状态 ============ */
const S = { projects: [], tasks: [], ideas: [], decisions: [], meetings: [], contacts: [], cur: null, mode: 'project', view: 'list', search: '', theme: 'light', calMonth: '', todayPid: null,
  smartId: null, timer: null, trashCount: 0, smartViews: [], rules: {}, frogs: { date: '', ids: [] }, shutdownTime: '', qInbox: false,
  dailyGoal: 5, noteDate: TODAY, dnMonth: TODAY.slice(0, 7) };
let editingTaskId = null;
let editingProjectId = null;
const RISK_RED = 15; /* 概率×影响 ≥15 标红置顶 */

function curProject() { return S.projects.find(p => p.id == S.cur) || S.projects[0] || null; }
function projTasks(pid) { return S.tasks.filter(t => t.projectId == pid); }
function getTask(id) { return S.tasks.find(t => t.id == id); }
function projNameOf(pid) { if (pid == 0) return '📥 收件箱'; const p = S.projects.find(x => x.id == pid); return p ? p.name : ''; }
function repeatLabel(rep) { return rep === 'daily' ? '每日' : rep === 'weekly' ? '每周' : rep === 'monthly' ? '每月' : ''; }
/* 距上次更新多少天（无记录则退回创建日期） */
function staleDays(t) {
  const base = (t.updatedAt || t.createdAt || '').slice(0, 10);
  return base ? -daysDiff(base) : 0;
}
function riskValue(t) { return (t.risk && t.riskProb > 0 && t.riskImpact > 0) ? (t.riskProb * t.riskImpact) : 0; }
function isOpen(t) { return t.status !== 'done'; }
function isOverdue(t) { return isOpen(t) && t.status !== 'wait' && t.due && t.due < TODAY; }
function subTasksOf(tid) { return S.tasks.filter(t => t.parentId == tid); }
/* 递归收集全部后代 id（带防环）：选父任务/级联删除时用，只排除直接子任务会漏掉孙任务导致成环 */
function allDescendantIds(tid) {
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
function rollupSummary(t) {
  const cl = checklistSummary(t);
  const subs = subTasksOf(t.id);
  const done = (cl ? cl.done : 0) + subs.filter(s => s.status === 'done').length;
  const total = (cl ? cl.total : 0) + subs.length;
  return total ? { done: done, total: total, subs: subs.length } : null;
}
function parseSettings(p) {
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
function parseChecklist(t) {
  try {
    const arr = JSON.parse(t.checklistJson || '[]');
    if (Array.isArray(arr)) return arr.filter(x => x && typeof x.text === 'string');
  } catch (e) {}
  return [];
}
function checklistSummary(t) {
  const items = parseChecklist(t);
  if (!items.length) return null;
  return { done: items.filter(x => x.done).length, total: items.length };
}

/* ============ 初始化 ============ */
async function getJsonMeta(key, fallback) {
  try {
    const v = await invoke('get_meta', { key: key });
    if (!v) return fallback;
    const p = JSON.parse(v);
    return p == null ? fallback : p;
  } catch (e) { return fallback; }
}
async function putJsonMeta(key, val) {
  await invoke('set_meta', { key: key, value: JSON.stringify(val) });
}

/* ============ 改版一次性导览（v2.1）：localStorage 记忆，任意方式关闭后不再弹 ============ */
function ensureTourDom() {
  if ($id('mw-tour')) return;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="mwrap" id="mw-tour" hidden>'
    + '<div class="modal tour-modal">'
    + '<h3>👋 界面焕新了 —— 功能一个没少，只是换了摆放位置</h3>'
    + '<div class="tour-sub">30 秒看完这 5 条，老功能都能找到：</div>'
    + '<div class="tour-row"><span class="ti">🧭</span><div><b>侧栏四分组</b>：今日聚焦 / 收件箱 → 项目（含已归档）→ 洞察（智能视图 / 需求池）→ 记录（会议纪要 / 干系人 / 每日笔记）；页脚只留 主题 / 提醒 / 回收站 / 设置</div></div>'
    + '<div class="tour-row"><span class="ti">🗂</span><div><b>项目内两层页签</b>：上面一层 任务 / 统计 / 决策 / 档案；任务页里再选 列表 / 看板 / 日历 / 时间线</div></div>'
    + '<div class="tour-row"><span class="ti">⋯</span><div><b>顶栏「项目工具」</b>：Excel 导入导出、CSV / Markdown 导出、项目设置、另存为模板，都收在这个菜单里</div></div>'
    + '<div class="tour-row"><span class="ti">⚙</span><div><b>设置分五节</b>：通用 / 自动化 / 桌面集成 / AI 供应商 / 数据（立即备份与 JSON 导入在这里）</div></div>'
    + '<div class="tour-row"><span class="ti">⌨</span><div><b>常用快捷键</b>：N 新建任务 ｜ 1-4 切换任务视图 ｜ 5-7 直达统计 / 决策 / 档案 ｜ / 搜索 ｜ Ctrl+K 命令面板</div></div>'
    + '<div class="tour-foot"><button class="btn blue" onclick="markTourSeen()">开始使用</button></div>'
    + '</div></div>');
}
function markTourSeen() {
  try { localStorage.setItem('pm_seen_tour', '2.1'); } catch (e) {}
  closeModal('mw-tour');
}
function maybeShowTour() {
  let seen = '';
  try { seen = localStorage.getItem('pm_seen_tour') || ''; } catch (e) {}
  if (!seen) openModal('mw-tour');
}

async function init() {
  try {
    const data = await invoke('load_app');
    S.projects = data.projects || [];
    S.tasks = data.tasks || [];
    S.ideas = data.ideas || [];
    S.decisions = data.decisions || [];
    S.meetings = data.meetings || [];
    S.contacts = data.contacts || [];
    if (!S.ideas.length) { try { S.ideas = await invoke('list_ideas') || []; } catch (e) {} }
    if (!S.projects.length) await createProject('示例项目');
    S.cur = await invoke('get_meta', { key: 'currentId' }) || ('' + S.projects[0].id);
    S.view = await invoke('get_meta', { key: 'view' }) || 'list';
    S.theme = await invoke('get_meta', { key: 'theme' }) || 'light';
    if (!curProject()) S.cur = '' + S.projects[0].id;
    applyTheme();
    updateRemindBtn(await invoke('get_meta', { key: 'notifyTime' }) || '');
    await loadRules();
    await loadFrogs();
    await loadSmartViews();
    S.shutdownTime = await invoke('get_meta', { key: 'shutdownTime' }) || '';
    S.dailyGoal = +(await invoke('get_meta', { key: 'dailyGoal' })) || 5;
    try {
      const tm = await invoke('get_timer');
      if (tm && getTask(tm.taskId)) S.timer = { taskId: tm.taskId, startedAt: tm.startedAt };
    } catch (e) {}
    try { S.trashCount = ((await invoke('list_deleted')) || []).length; } catch (e) { S.trashCount = 0; }
    await generateFollowupTasks();
    await routineReset();
    ensureTourDom();
    bindEvents();
    bindDesktopEvents();
    render();
    updateTimerBar();
    setInterval(timerTick, 1000);
    setInterval(shutdownCheck, 30000);
    setInterval(refreshTrashCount, 60000);
    setInterval(() => { try { updateTaskbarProgress(); } catch (e) {} }, 30000);
    setInterval(() => { checkDayRollover().catch(() => {}); }, 30000);
    maybeShowTour();
  } catch (e) {
    toastErr('加载数据失败', e);
    bindEvents();
  }
}

/* 桌面集成事件（包2）：深链接跳回任务/项目 + 快速捕获窗口新增任务后刷新 */
function bindDesktopEvents() {
  try {
    const ev = window.__TAURI__.event;
    if (!ev || !ev.listen) return;
    ev.listen('pm-deeplink', e => {
      const url = String(e.payload || '');
      const m = url.match(/^pm-todo:\/\/task\/(\d+)/i);
      const mp = url.match(/^pm-todo:\/\/project\/(\d+)/i);
      if (m) {
        const t = getTask(+m[1]);
        if (t) {
          S.cur = '' + t.projectId;
          S.mode = 'project';
          render();
          openTaskEdit(t.id);
          toast('🔗 从链接跳入：' + t.title.slice(0, 24), 'info');
        } else toast('链接指向的任务不存在（可能已删除）', 'err');
      } else if (mp) {
        const p = S.projects.find(x => x.id == mp[1]);
        if (p) { switchProject(p.id); toast('🔗 从链接跳入项目：' + p.name, 'info'); }
      }
    });
    ev.listen('quick-task-added', () => { refreshAll(); toast('⚡ 已从快速捕获小窗加入收件箱', 'info'); });
  } catch (e) {}
}

/* ---------- 自动化规则（#13，预置开关，非通用引擎） ---------- */
const RULE_DEFAULTS = { overdueTop: 1, staleCleanup: 1, doneStopTimer: 1, inboxNudge: 1 };
async function loadRules() {
  S.rules = Object.assign({}, RULE_DEFAULTS, await getJsonMeta('autoRules', {}));
}
async function loadFrogs() {
  const f = await getJsonMeta('frogs', { date: '', ids: [] });
  if (f.date !== TODAY || !Array.isArray(f.ids)) S.frogs = { date: TODAY, ids: [] };
  else S.frogs = f;
}
async function saveFrogs() { await putJsonMeta('frogs', S.frogs); }

/* 今日三只青蛙（#7）：最多 3 只 */
async function toggleFrog(id) {
  const t = getTask(id); if (!t) return;
  const i = S.frogs.ids.indexOf(id);
  if (i >= 0) {
    S.frogs.ids.splice(i, 1);
    toast('已移出今日要事', 'info');
  } else {
    if (t.status === 'done') { toast('已完成的任务不进青蛙', 'info'); return; }
    if (S.frogs.ids.length >= 3) { toast('最多 3 只青蛙 🐸：先完成或移除一只', 'err'); return; }
    S.frogs.ids.push(id);
    toast('🐸 已设为今日要事第 ' + S.frogs.ids.length + ' 位');
  }
  S.frogs.date = TODAY;
  try { await saveFrogs(); render(); } catch (e) { toastErr('保存失败', e); }
}

/* ---------- 智能视图（#9） ---------- */
const SMART_SEED = [
  { id: 'risk-reg', name: '⚠ 风险登记册', crit: { risk: 1 }, builtin: 1, register: 1 },
  { id: 'risk-over', name: '⚠ 风险且逾期', crit: { risk: 1, overdue: 1 }, builtin: 1 },
  { id: 'wait-3', name: '⏳ 等待超 3 天', crit: { waitDays: 3 }, builtin: 1 }
];
async function loadSmartViews() {
  const v = await getJsonMeta('smartViews', null);
  if (!v || !Array.isArray(v) || !v.length) S.smartViews = SMART_SEED.slice();
  else S.smartViews = v;
}
function matchSmart(t, crit) {
  if (!isOpen(t)) return false;
  if (crit.risk && !t.risk) return false;
  if (crit.overdue && !isOverdue(t)) return false;
  if (crit.waitDays && !(t.status === 'wait' && staleDays(t) >= crit.waitDays)) return false;
  if (crit.staleDays && !(staleDays(t) >= crit.staleDays)) return false;
  if (crit.pri && (t.pri || 'P1') !== crit.pri) return false;
  return true;
}
function smartTaskCount(v) {
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  return S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && matchSmart(t, v.crit)).length;
}

/* 循环任务：完成后下一次到期日 */
function nextOccurrence(doneAt, rep) {
  if (rep === 'weekly') return addDays(doneAt, 7);
  if (rep === 'monthly') return addMonths(doneAt, 1);
  return TODAY; // daily：第二天重新出现
}
async function routineReset() {
  const changed = S.tasks.filter(t => {
    if (!t.repeat || t.status !== 'done' || !t.doneAt || t.doneAt === TODAY) return false;
    const next = nextOccurrence(t.doneAt, t.repeat);
    return next <= TODAY; // 每日任务次日即重置；每周/每月到点才重新出现
  });
  for (const t of changed) {
    const next = nextOccurrence(t.doneAt, t.repeat);
    t.status = 'todo'; t.doneAt = '';
    t.due = next;
    try { await persistTask(t); } catch (e) { toastErr('重置循环任务失败', e); }
  }
}
/* 跨天检测：常驻应用跨过午夜后刷新 TODAY、重置青蛙与循环任务，并重渲染（否则次日全部按旧日期判断） */
async function checkDayRollover() {
  const t = todayStr();
  if (t === TODAY) return;
  TODAY = t;
  try { await loadFrogs(); } catch (e) {}
  try { await routineReset(); } catch (e) {}
  render();
}

/* ============ 数据操作 ============ */
async function persistTask(t) {
  const saved = await invoke('upsert_task', { task: t });
  const i = S.tasks.findIndex(x => x.id === saved.id);
  if (i >= 0) S.tasks[i] = saved; else S.tasks.push(saved);
  return saved;
}
async function persistProject(p) {
  const saved = await invoke('upsert_project', { project: p });
  const i = S.projects.findIndex(x => x.id === saved.id);
  if (i >= 0) S.projects[i] = saved; else S.projects.push(saved);
  return saved;
}
async function createProject(name) {
  const p = await persistProject({
    id: 0, name: name, archived: false, createdAt: TODAY,
    settingsJson: JSON.stringify({ report: name + ' 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] })
  });
  if (!S.cur) S.cur = '' + p.id;
  return p;
}

async function switchProject(id) {
  S.cur = '' + id;
  S.mode = 'project';
  try { await invoke('set_meta', { key: 'currentId', value: S.cur }); } catch (e) {}
  render();
}

async function setStatus(id, s) {
  const t = getTask(id); if (!t) return;
  t.status = s;
  t.doneAt = (s === 'done') ? TODAY : '';
  if (s === 'doing') {
    if (!t.doingSince) t.doingSince = nowMinStr(); /* cycle time：记录首次开始时间 */
  } else if (s === 'done') {
    t.deferCount = 0; /* 完成清零拖延徽章 */
  } else if (t.doingSince && s !== 'doing') {
    t.doingSince = ''; /* 退回待办则清空周期起点 */
  }
  const max = projTasks(t.projectId).reduce((m, x) => Math.max(m, Math.abs(x.sortOrder) || 0), 0);
  t.sortOrder = max + 1;
  try {
    if (s === 'done' && S.rules.doneStopTimer && S.timer && S.timer.taskId == id) await stopTimerFlow(true);
    await persistTask(t); render();
  } catch (e) { toastErr('更新状态失败', e); }
}

/* 一键推迟到明天（#3）：拖延徽章 +1 */
async function snoozeTask(id) {
  const t = getTask(id); if (!t) return;
  t.due = addDays(TODAY, 1);
  t.deferCount = (t.deferCount || 0) + 1;
  if (t.status === 'wait') t.status = 'todo';
  try {
    await persistTask(t); render();
    toast('已推迟到明天（第 ' + t.deferCount + ' 次）' + (t.deferCount >= 3 ? ' ⚠ 该任务已连续推迟 3 次以上，考虑删除、改期或升级处理' : ''), t.deferCount >= 3 ? 'err' : 'ok');
  } catch (e) { toastErr('推迟失败', e); }
}

/* 置顶：sortOrder 负数 = 置顶 */
async function togglePin(id) {
  const t = getTask(id); if (!t) return;
  if (t.sortOrder < 0) {
    const max = projTasks(t.projectId).reduce((m, x) => Math.max(m, x.sortOrder || 0), 0);
    t.sortOrder = max + 1;
    toast('已取消置顶', 'info');
  } else {
    const min = projTasks(t.projectId).reduce((m, x) => Math.min(m, x.sortOrder || 0), 0);
    t.sortOrder = min - 1;
    toast('已置顶，将显示在分组最前', 'info');
  }
  try { await persistTask(t); render(); } catch (e) { toastErr('操作失败', e); }
}

async function delTaskById(id, allowUndo) {
  const t = getTask(id); if (!t) return;
  const descIds = allDescendantIds(id); /* 后端会级联删除子孙任务，本地状态同步移除 */
  try {
    const trashId = await invoke('delete_task', { id: id });
    if (S.timer && (S.timer.taskId == id || descIds.indexOf(S.timer.taskId) >= 0)) { S.timer = null; updateTimerBar(); }
    S.tasks = S.tasks.filter(x => x.id != id && descIds.indexOf(x.id) < 0);
    S.frogs.ids = S.frogs.ids.filter(x => x != id && descIds.indexOf(x) < 0);
    refreshTrashCount();
    render();
    if (allowUndo && trashId) {
      toast('已删除「' + t.title.slice(0, 18) + '」（可在回收站找回）', 'info', {
        label: '撤销',
        onClick: async () => {
          try { await invoke('restore_deleted', { id: trashId }); await refreshAll(); toast('已恢复'); }
          catch (e) { toastErr('恢复失败', e); }
        }
      });
    } else {
      toast('已移入回收站，30 天内可恢复');
    }
  } catch (e) { toastErr('删除失败', e); }
}

/* 重新从后端拉全量数据（恢复/导入后调用） */
async function refreshAll() {
  const data = await invoke('load_app');
  S.projects = data.projects || [];
  S.tasks = data.tasks || [];
  S.ideas = data.ideas || [];
  if (!curProject()) S.cur = '' + (S.projects[0] ? S.projects[0].id : '');
  await refreshTrashCount();
  render();
}

/* ---------- 回收站（#5） ---------- */
async function refreshTrashCount() {
  try { S.trashCount = ((await invoke('list_deleted')) || []).length; } catch (e) { return; }
  const el = $id('btnTrashCnt');
  if (el) el.textContent = S.trashCount || '';
}
async function openTrash() {
  let items = [];
  try { items = await invoke('list_deleted') || []; } catch (e) { toastErr('读取回收站失败', e); return; }
  S.trashCount = items.length;
  const box = $id('trash-list');
  box.innerHTML = items.length ? items.map(it => {
    const isProj = it.kind === 'project';
    return '<div class="trash-row">'
      + '<span class="tk">' + (isProj ? '📂' : '☰') + '</span>'
      + '<span class="tsum">' + esc(it.summary || '（无标题）') + '</span>'
      + '<span class="tdt">' + esc((it.deletedAt || '').slice(5, 16)) + '</span>'
      + '<button class="btn ghost" onclick="restoreTrash(' + it.id + ')">恢复</button>'
      + '<button class="btn danger ghost" onclick="purgeTrash(' + it.id + ')">彻底删除</button>'
      + '</div>';
  }).join('') : '<div class="empty">回收站是空的</div>';
  $id('trash-cnt').textContent = items.length;
  openModal('mw-trash');
}
async function restoreTrash(id) {
  try {
    await invoke('restore_deleted', { id: id });
    closeModal('mw-trash');
    await refreshAll();
    toast('已恢复');
  } catch (e) { toastErr('恢复失败', e); }
}
async function purgeTrash(id) {
  const ok = await askConfirm('彻底删除', '彻底删除后无法再恢复，继续？', true);
  if (!ok) return;
  try {
    await invoke('purge_deleted', { id: id });
    await openTrash();
    refreshTrashCount();
    toast('已彻底删除');
  } catch (e) { toastErr('操作失败', e); }
}
async function purgeTrashOld() {
  const ok = await askConfirm('清空过期条目', '彻底删除回收站中超过 30 天的条目，继续？', true);
  if (!ok) return;
  try {
    await invoke('purge_deleted', { id: null });
    await openTrash();
    refreshTrashCount();
    toast('已清空过期条目');
  } catch (e) { toastErr('操作失败', e); }
}

/* ---------- 任务计时（#1） ---------- */
async function toggleTimer(id) {
  try {
    if (S.timer && S.timer.taskId == id) { await stopTimerFlow(false); return; }
    if (S.timer) await stopTimerFlow(true);
    await invoke('start_timer', { taskId: id });
    S.timer = { taskId: id, startedAt: Math.floor(Date.now() / 1000) };
    updateTimerBar();
    render();
  } catch (e) { toastErr('计时失败', e); }
}
async function stopTimerFlow(silent) {
  try {
    const mins = await invoke('stop_timer');
    S.timer = null;
    updateTimerBar();
    if (!silent) toast(mins > 0 ? '⏱ 已记录 ' + mins + ' 分钟工时' : '计时已停止', mins > 0 ? 'ok' : 'info');
    render();
  } catch (e) { S.timer = null; updateTimerBar(); toastErr('停止计时失败', e); }
}
function timerText(startedAt) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return pad(h) + ':' + pad(m) + ':' + pad(ss);
}
function timerTick() {
  if (!S.timer) return;
  const el = $id('timerTime');
  if (el) el.textContent = timerText(S.timer.startedAt);
}
function updateTimerBar() {
  const bar = $id('timerBar');
  if (!bar) return;
  if (!S.timer) { bar.hidden = true; return; }
  const t = getTask(S.timer.taskId);
  bar.hidden = false;
  $id('timerTaskName').textContent = t ? t.title : '（任务不存在）';
  $id('timerTime').textContent = timerText(S.timer.startedAt);
}

/* ============ 快速添加（自然语言解析） ============ */
function parseQuick(raw) {
  let s = ' ' + raw.trim() + ' ';
  const t = { due: TODAY, owner: '我方', pri: 'P1', risk: false, repeat: '', title: '' };
  const rel = { '大后天': 3, '后天': 2, '明天': 1, '今天': 0 };
  s = s.replace(/(大后天|后天|明天|今天)/g, m => { t.due = addDays(TODAY, rel[m]); return ' '; });
  s = s.replace(/下周([一二三四五六日天])/g, (m, d) => {
    t.due = nextWeekday(d, true);
    return ' ';
  });
  /* 每周五 / 每月20号：循环 + 具体到期日（必须放在通用「周X」解析之前） */
  s = s.replace(/每周([一二三四五六日天])/g, (m, d) => {
    t.repeat = 'weekly';
    t.due = nextWeekday(d, false);
    return ' ';
  });
  s = s.replace(/每月\s*(\d{1,2})\s*[号日]?/g, (m, d) => {
    t.repeat = 'monthly';
    const dd = Math.max(1, +d);
    const curYm = TODAY.slice(0, 7);
    const dim = new Date(+curYm.slice(0, 4), +curYm.slice(5), 0).getDate();
    let due = curYm + '-' + pad(Math.min(dd, dim));
    if (due < TODAY) {
      /* 下月天数：月份参数 +1 才是下月（复制粘贴错误会漏掉下月比本月长的场景，如 2 月设"每月30号"） */
      const nextDim = new Date(+curYm.slice(0, 4), +curYm.slice(5) + 1, 0).getDate();
      due = addMonths(curYm + '-15', 1).slice(0, 8) + pad(Math.min(dd, nextDim));
    }
    t.due = due;
    return ' ';
  });
  s = s.replace(/(?<![0-9])周([一二三四五六日天天])(?![\d月])/g, (m, d) => {
    t.due = nextWeekday(d, false);
    return ' ';
  });
  s = s.replace(/[+＋]\s*(\d+)\s*天?/g, (m, n) => { t.due = addDays(TODAY, +n); return ' '; });
  s = s.replace(/(\d{4}-\d{1,2}-\d{1,2})/g, m => {
    const p = m.split('-');
    t.due = p[0] + '-' + pad(+p[1]) + '-' + pad(+p[2]);
    return ' ';
  });
  s = s.replace(/@([^\s!#@]+)/g, (m, o) => { t.owner = o; return ' '; });
  s = s.replace(/!(P0|P1|P2)/gi, (m, p) => { t.pri = p.toUpperCase(); return ' '; });
  s = s.replace(/#风险/g, () => { t.risk = true; return ' '; });
  s = s.replace(/#(每日|每天)/g, () => { t.repeat = 'daily'; return ' '; });
  s = s.replace(/#每周/g, () => { t.repeat = 'weekly'; return ' '; });
  s = s.replace(/#每月/g, () => { t.repeat = 'monthly'; return ' '; });
  t.title = s.replace(/\s+/g, ' ').trim();
  return t;
}
function nextWeekday(cn, nextWeek) {
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  const target = map[cn] || 1;
  const curDow = new Date().getDay() || 7;
  let delta;
  if (nextWeek) delta = (8 - curDow) + (target - 1);
  else {
    delta = target - curDow;
    if (delta < 0) delta += 7;
    if (delta === 0) delta = 7;
  }
  return addDays(TODAY, delta);
}

async function quickAdd() {
  const raw = $id('quick').value;
  if (!raw.trim()) { toast('先输入内容，或点右侧 📅 👤 🚩 按钮组装任务', 'info'); return; }
  const t = parseQuick(raw);
  if (!t.title) { toast('没解析出标题：日期/负责人等要写在前、后留出标题文字', 'err'); return; }
  /* 今日聚焦模式下从下拉框选择目标项目，默认上次浏览的项目；📥 收件箱模式先进收件箱 */
  let pid;
  if (S.qInbox) {
    pid = 0;
  } else if (S.mode === 'today') {
    const sel = $id('qProj');
    pid = +sel.value;
    if (!pid) { const p = curProject(); pid = p ? p.id : 0; }
  } else {
    const p = curProject(); if (!p) return;
    pid = p.id;
  }
  if (pid !== 0 && !pid) { toast('请先创建一个项目', 'err'); return; }
  try {
    await persistTask({
      id: 0, projectId: pid, title: t.title, due: t.due, owner: t.owner, pri: t.pri,
      status: 'todo', doneAt: '', risk: t.risk, repeat: t.repeat, note: '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
    });
    $id('quick').value = '';
    quickPreviewRender();
    $id('quick').focus();
    const where = pid === 0 ? '📥 收件箱' : '「' + projNameOf(pid) + '」';
    const dueLabel = t.due === TODAY ? '今天' : t.due;
    toast('已添加到' + where + '：' + t.title + '（' + dueLabel + ' · ' + t.owner + ' · ' + t.pri
      + (t.risk ? ' · ⚠风险' : '') + (t.repeat ? ' · 🔄' + repeatLabel(t.repeat) : '') + '）');
    render();
  } catch (e) { toastErr('添加失败', e); }
}
function toggleQInbox() {
  S.qInbox = !S.qInbox;
  $id('q-inbox').classList.toggle('on', S.qInbox);
  $id('quick').placeholder = S.qInbox ? '📥 收件箱模式：输入后回车，先不分项目，之后再分拣' : '输入任务，回车添加；或用右侧按钮插入日期/负责人/优先级';
  $id('quick').focus();
}

/* ---------- 快速添加：实时预览 + 令牌按钮 ---------- */
function quickPreviewRender() {
  const v = $id('quick').value;
  const box = $id('quickPreview');
  if (!v.trim()) { box.hidden = true; hideQPop(); return; }
  const t = parseQuick(v);
  let chips = '<span class="chip2 cd">📆 ' + esc(t.due === TODAY ? '今天' : t.due) + '</span>'
    + '<span class="chip2">👤 ' + esc(t.owner) + '</span>'
    + '<span class="chip2 ' + (t.pri === 'P0' ? 'bad' : '') + '">' + esc(t.pri) + '</span>';
  if (t.risk) chips += '<span class="chip2 warn">⚠ 风险</span>';
  if (t.repeat) chips += '<span class="chip2">🔄 ' + repeatLabel(t.repeat) + '</span>';
  chips += '<span class="qp-title">' + (t.title ? esc(t.title) : '<i>继续输入任务内容…</i>') + '</span>';
  box.innerHTML = chips;
  box.hidden = false;
  syncQToolStates();
}
function qInsert(token) {
  const el = $id('quick');
  const has = el.value.indexOf(token) >= 0;
  if (!has) el.value = (el.value.trimEnd() + (el.value.trim() ? ' ' : '') + token).trim();
  el.focus();
  quickPreviewRender();
}
function qRemoveToken(re) {
  const el = $id('quick');
  el.value = el.value.replace(re, ' ').replace(/\s+/g, ' ').trim();
}
function syncQToolStates() {
  const v = $id('quick').value;
  $id('q-risk').classList.toggle('on', v.indexOf('#风险') >= 0);
  $id('q-repeat').classList.toggle('on', /#(每日|每天|每周|每月)/.test(v));
}
let qPopKind = null;
function hideQPop() { $id('qPop').hidden = true; qPopKind = null; }
function qTogglePop(kind, btn) {
  if (qPopKind === kind) { hideQPop(); return; }
  qPopKind = kind;
  const pop = $id('qPop');
  if (kind === 'date') {
    pop.innerHTML = '<span class="q-pop-label">选择截止日期</span>'
      + ['今天|今天', '明天|明天', '后天|后天', '大后天|大后天'].map(x => {
          const p = x.split('|');
          return '<button onclick="qInsert(\'' + p[1] + '\');hideQPop()">' + p[0] + '</button>';
        }).join('')
      + '<button onclick="qInsert(\'下周三\');hideQPop()">下周三</button>'
      + '<input type="date" onchange="if(this.value){qInsert(this.value);hideQPop()}">';
  } else if (kind === 'owner') {
    const owners = [];
    const p = curProject();
    if (p) projTasks(p.id).forEach(t => { if (t.owner && owners.indexOf(t.owner) < 0 && t.owner !== '我方') owners.push(t.owner); });
    pop.innerHTML = '<span class="q-pop-label">选择负责人</span>'
      + '<button onclick="qRemoveToken(/@[^\\s!#@]+/g);qInsert(\'@我方\');hideQPop()">我方</button>'
      + owners.slice(0, 8).map(o => '<button onclick="qRemoveToken(/@[^\\s!#@]+/g);qInsert(\'@' + esc(o).replace(/'/g, '') + '\');hideQPop()">' + esc(o) + '</button>').join('');
  } else if (kind === 'pri') {
    pop.innerHTML = '<span class="q-pop-label">选择优先级</span>'
      + [['P0', 'P0 紧急'], ['P1', 'P1 常规'], ['P2', 'P2 低']].map(x =>
          '<button onclick="qRemoveToken(/\\s*!P\\d/gi);qInsert(\'!' + x[0] + '\');hideQPop()">' + x[1] + '</button>').join('');
  }
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
}

/* ============ 搜索与筛选令牌 ============ */
function parseFilter(raw) {
  const f = { kw: '', owner: '', pri: '', risk: false, rep: '' };
  let s = ' ' + raw.trim() + ' ';
  s = s.replace(/@([^\s!#@]+)/g, (m, o) => { f.owner = o; return ' '; });
  s = s.replace(/!(P0|P1|P2)/gi, (m, p) => { f.pri = p.toUpperCase(); return ' '; });
  s = s.replace(/#风险/g, () => { f.risk = true; return ' '; });
  s = s.replace(/#(每日|每天|每周|每月)/g, (m, r) => { f.rep = r === '每周' ? 'weekly' : r === '每月' ? 'monthly' : 'daily'; return ' '; });
  f.kw = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return f;
}
function filteredTasks() {
  const p = curProject(); if (!p) return [];
  const f = parseFilter(S.search);
  let ts = projTasks(p.id);
  if (f.owner) ts = ts.filter(t => (t.owner || '').indexOf(f.owner) >= 0);
  if (f.pri) ts = ts.filter(t => (t.pri || 'P1') === f.pri);
  if (f.risk) ts = ts.filter(t => t.risk);
  if (f.rep) ts = ts.filter(t => t.repeat === f.rep);
  if (f.kw) ts = ts.filter(t => (t.title + ' ' + (t.owner || '') + ' ' + (t.note || '')).toLowerCase().indexOf(f.kw) >= 0);
  return ts;
}
function cmpTask(a, b) {
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

/* ============ 渲染 ============ */
function render() {
  renderSidebar();
  renderHeader();
  renderView();
}

function renderSidebar() {
  /* 今日聚焦：跨项目的今日待办总数 */
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  const tCnt = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && t.status !== 'done' && t.status !== 'wait' && t.due <= TODAY).length;
  const iCnt = S.tasks.filter(t => t.projectId == 0 && t.status === 'todo').length;
  $id('todayNav').innerHTML =
    '<div class="proj today ' + (S.mode === 'today' ? 'on' : '') + '" onclick="openTodayFocus()" title="所有项目的今日到期 / 逾期 / 进行中">'
    + '<span class="dot"></span><span class="nm">📅 今日聚焦</span>'
    + '<span class="cnt ' + (tCnt ? 'hot' : '') + '">' + tCnt + '</span></div>'
    + '<div class="proj ' + (S.mode === 'inbox' ? 'on' : '') + '" onclick="openInbox()" title="快速添加时选 📥 先进收件箱，之后再分派到项目">'
    + '<span class="dot"></span><span class="nm">📥 收件箱</span>'
    + '<span class="cnt ' + (iCnt ? 'hot' : '') + '">' + iCnt + '</span></div>';

  const alive = S.projects.filter(p => !p.archived);
  $id('projNav').innerHTML = alive.map(p => {
    const n = projTasks(p.id).filter(t => t.status !== 'done').length;
    return '<div class="proj ' + (S.mode === 'project' && p.id == S.cur ? 'on' : '') + '" onclick="switchProject(' + p.id + ')">'
      + '<span class="dot"></span><span class="nm">' + esc(p.name) + '</span>'
      + '<span class="cnt">' + n + '</span>'
      + '<button class="gear" title="项目设置" onclick="event.stopPropagation();openProjectSettings(' + p.id + ')">⚙</button></div>';
  }).join('') || '<div class="empty">暂无项目，点上方 ＋ 新建</div>';

  /* 智能视图（#9） + 规则自动化出的「待清理」（#13） */
  let smartHtml = S.smartViews.map(v =>
    '<div class="proj smart ' + (S.mode === 'smart' && S.smartId === v.id ? 'on' : '') + '" onclick="openSmartView(\'' + v.id + '\')">'
    + '<span class="dot"></span><span class="nm">' + esc(v.name) + '</span>'
    + '<span class="cnt">' + smartTaskCount(v) + '</span></div>').join('');
  if (S.rules.staleCleanup) {
    const staleCnt = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && isOpen(t) && staleDays(t) >= 14).length;
    if (staleCnt) {
      smartHtml += '<div class="proj smart ' + (S.mode === 'smart' && S.smartId === 'auto-stale' ? 'on' : '') + '" onclick="openSmartView(\'auto-stale\')" title="停滞超 14 天，建议每周回顾时清理">'
        + '<span class="dot"></span><span class="nm">🧹 待清理</span>'
        + '<span class="cnt hot">' + staleCnt + '</span></div>';
    }
  }
  $id('smartNav').innerHTML = smartHtml || '<div class="empty">暂无智能视图</div>';

  /* 需求池（#14） */
  const openIdeas = S.ideas.filter(x => !x.converted).length;
  $id('ideasNav').innerHTML =
    '<div class="proj ' + (S.mode === 'ideas' ? 'on' : '') + '" onclick="openIdeas()" title="记下领导口头诉求，评审时按 价值/工时 排优先级">'
    + '<span class="dot"></span><span class="nm">💡 需求池</span>'
    + '<span class="cnt ' + (openIdeas ? '' : '') + '">' + openIdeas + '</span></div>';

  /* 组织记忆（包3/包4）：会议纪要 / 干系人 / 每日笔记 */
  const dueContacts = S.contacts.filter(c => contactDueDays(c) <= 0).length;
  $id('memoryNav').innerHTML =
    '<div class="proj ' + (S.mode === 'meetings' ? 'on' : '') + '" onclick="openMeetings()" title="会后笔记模板：议题/参与人/结论/行动项，行动项一键转任务">'
    + '<span class="dot"></span><span class="nm">🗂 会议纪要</span><span class="cnt">' + S.meetings.length + '</span></div>'
    + '<div class="proj ' + (S.mode === 'contacts' ? 'on' : '') + '" onclick="openContacts()" title="干系人档案 + 跟进周期，到期自动生成跟进任务">'
    + '<span class="dot"></span><span class="nm">👥 干系人</span>'
    + '<span class="cnt ' + (dueContacts ? 'hot' : '') + '">' + (dueContacts ? dueContacts + '!' : S.contacts.length) + '</span></div>'
    + '<div class="proj ' + (S.mode === 'dailynote' ? 'on' : '') + '" onclick="openDailyNote()" title="每日笔记：当日任务+青蛙+收尾+会议自动聚合，可写自己的 MD">'
    + '<span class="dot"></span><span class="nm">📝 每日笔记</span></div>';

  const arch = S.projects.filter(p => p.archived);
  $id('archWrap').innerHTML = arch.length
    ? '<details><summary>已归档（' + arch.length + '）</summary>' + arch.map(p =>
        '<div class="proj ' + (S.mode === 'project' && p.id == S.cur ? 'on' : '') + '" onclick="switchProject(' + p.id + ')">'
        + '<span class="dot"></span><span class="nm">' + esc(p.name) + '</span>'
        + '<button class="gear" title="项目设置" onclick="event.stopPropagation();openProjectSettings(' + p.id + ')">⚙</button></div>').join('') + '</details>'
    : '';
}

let headerSeq = 0, statsSeq = 0;
async function renderHeader() {
  const p = curProject(); if (!p) return;
  const seq = ++headerSeq; /* 异步渲染竞态防护：await 后若已有更新一次渲染，本次结果作废 */
  const todayMode = S.mode === 'today';
  const specialMode = S.mode === 'inbox' || S.mode === 'ideas' || S.mode === 'smart' || S.mode === 'meetings' || S.mode === 'contacts' || S.mode === 'dailynote';
  $id('projName').textContent = S.mode === 'inbox' ? '📥 收件箱 · 待分拣'
    : S.mode === 'ideas' ? '💡 需求池'
    : S.mode === 'meetings' ? '🗂 会议纪要'
    : S.mode === 'contacts' ? '👥 干系人'
    : S.mode === 'dailynote' ? '📝 每日笔记'
    : S.mode === 'smart' ? (S.smartId === 'auto-stale' ? '🧹 待清理（停滞 ≥14 天）' : (smartViewById(S.smartId) || {}).name || '智能视图')
    : todayMode ? '📅 今日聚焦' : p.name;
  $id('projName').style.cursor = (todayMode || specialMode) ? 'default' : 'pointer';
  /* 两层页签高亮：一级=页面，二级=任务呈现 */
  const taskViews = ['list', 'kanban', 'calendar', 'timeline'];
  const isProj = !todayMode && !specialMode;
  document.querySelectorAll('#pageTabs button').forEach(b => {
    const on = isProj && (b.dataset.page === 'task' ? taskViews.indexOf(S.view) >= 0 : b.dataset.page === S.view);
    b.classList.toggle('on', on);
  });
  $id('viewSeg').hidden = !isProj || taskViews.indexOf(S.view) < 0;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', isProj && b.dataset.view === S.view));
  $id('projMoreWrap').hidden = !isProj;

  /* 日报/周报是项目级操作，今日聚焦/收件箱/需求池/智能视图下隐藏 */
  $id('btnDay').hidden = todayMode || specialMode;
  $id('btnWeek').hidden = todayMode || specialMode;
  $id('btnTodayCopy').hidden = !todayMode;
  $id('qProj').hidden = !todayMode || S.qInbox;

  if (S.mode === 'inbox') {
    const list = S.tasks.filter(t => t.projectId == 0 && t.status === 'todo');
    $id('countdown').innerHTML = '<span class="chip2 ' + (list.length ? 'cd' : 'good') + '">📥 待分拣 ' + list.length + ' 条</span>'
      + '<span class="chip2">每天先花 2 分钟：逐条分派到项目，或改期/删除</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'meetings') {
    const recent = S.meetings.filter(m => m.date >= addDays(TODAY, -30)).length;
    $id('countdown').innerHTML = '<span class="chip2 cd">🗂 近 30 天 ' + recent + ' 场</span>'
      + '<span class="chip2">行动项必须落成任务才有人追（Fellow 核心交互）</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'contacts') {
    const due = S.contacts.filter(c => contactDueDays(c) <= 0);
    $id('countdown').innerHTML = '<span class="chip2 ' + (due.length ? 'bad' : 'good') + '">👥 待跟进 ' + due.length + ' 人</span>'
      + '<span class="chip2">到期自动生成「跟进某人」进今日聚焦（FollowUpThen 机制）</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'dailynote') {
    $id('countdown').innerHTML = '<span class="chip2 cd">📝 ' + S.noteDate + '</span>'
      + '<span class="chip2">任务 / 青蛙 / 收尾 / 会议自动聚合，下方可写自己的笔记</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'ideas') {
    const open = S.ideas.filter(x => !x.converted);
    $id('countdown').innerHTML = '<span class="chip2 cd">💡 待评审 ' + open.length + ' 条</span>'
      + '<span class="chip2">按 价值/工时 排序，四象限辅助决策</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'smart') {
    const v = smartViewById(S.smartId);
    const archIds = S.projects.filter(pp => pp.archived).map(pp => pp.id);
    const crit = S.smartId === 'auto-stale' ? { staleDays: 14 } : (v ? v.crit : null);
    const n = crit ? S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && matchSmart(t, crit)).length : 0;
    $id('countdown').innerHTML = '<span class="chip2 cd">' + esc(v ? v.name : '🧹 待清理') + ' · ' + n + ' 条</span>'
      + (v && !v.builtin ? '<button class="linkbtn" onclick="deleteSmartView(\'' + v.id + '\')">删除此视图</button>' : '');
    $id('statsbar').innerHTML = '';
  } else if (todayMode) {
    const groups = todayGroups();
    let nOver = 0, nToday = 0, nDoing = 0;
    groups.forEach(g => { nOver += g.over.length; nToday += g.today.length; nDoing += g.doing.length; });
    $id('countdown').innerHTML =
      (nOver ? '<span class="chip2 bad">🔴 逾期 ' + nOver + '</span>' : '<span class="chip2 good">无逾期</span>')
      + '<span class="chip2 cd">📆 今天到期 ' + nToday + '</span>'
      + '<span class="chip2">🔨 进行中 ' + nDoing + '</span>'
      + '<span class="chip2">共 ' + (nOver + nToday + nDoing) + ' 项 · ' + groups.length + ' 个项目</span>';
    $id('statsbar').innerHTML = '';
  } else {
    const s = parseSettings(p);
    const cds = [];
    s.milestones.forEach(m => {
      if (m.label && m.date) {
        const diff = daysDiff(m.date);
        cds.push('<span class="chip2 cd">🏁 ' + esc(m.label) + ' ' + m.date.slice(5) + ' · ' + (diff >= 0 ? '剩 ' + diff + ' 天' : '已过 ' + (-diff) + ' 天') + '</span>');
      }
    });
    $id('countdown').innerHTML = cds.length ? cds.join('') : '<span class="chip2">⚙ 点项目名可设置里程碑倒计时</span>';

    const ts = projTasks(p.id);
    const overdue = ts.filter(t => t.status !== 'done' && t.status !== 'wait' && t.due < TODAY).length;
    const risks = ts.filter(t => t.risk && t.status !== 'done').length;
    const wk = addDays(TODAY, -6);
    const wkDone = ts.filter(t => t.status === 'done' && t.doneAt && t.doneAt >= wk && t.doneAt <= TODAY).length;
    let budgetChip = '';
    const s0 = parseSettings(p);
    if (s0.budgetHours > 0) {
      try {
        const logs = await invoke('get_time_logs', { since: '2000-01-01' }) || [];
        if (seq !== headerSeq) return; /* await 期间用户切走时，旧项目的工时不得写入新页头 */
        const used = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const pct = Math.round(used / s0.budgetHours * 100);
        budgetChip = '<span class="chip2 ' + (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'good') + '" title="80%/100% 触发托盘通知与群推送">⏳ 工时 ' + used.toFixed(1) + '/' + s0.budgetHours + 'h（' + pct + '%）</span>';
      } catch (e) {}
    }
    $id('statsbar').innerHTML =
      '<span class="chip2 good">本周完成 ' + wkDone + '</span>' +
      (overdue ? '<span class="chip2 bad">逾期 ' + overdue + '</span>' : '') +
      (risks ? '<span class="chip2 warn">风险 ' + risks + '</span>' : '') +
      budgetChip +
      '<span class="chip2">共 ' + ts.length + ' 项</span>';
  }

  const owners = [];
  S.tasks.forEach(t => { if (t.owner && owners.indexOf(t.owner) < 0) owners.push(t.owner); });
  $id('ownerList').innerHTML = owners.map(o => '<option value="' + esc(o) + '">').join('');

  /* 今日聚焦下的快速添加：选择任务加入的项目（默认上次浏览的项目） */
  if (todayMode) {
    const alive = S.projects.filter(x => !x.archived);
    if (!S.todayPid || !alive.some(x => x.id == S.todayPid)) S.todayPid = S.cur;
    $id('qProj').innerHTML = alive.map(x =>
      '<option value="' + x.id + '"' + (x.id == S.todayPid ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
  }
}

function renderView() {
  const isToday = S.mode === 'today';
  const special = !isToday && S.mode !== 'project';
  $id('viewToday').hidden = !isToday;
  $id('viewInbox').hidden = S.mode !== 'inbox';
  $id('viewIdeas').hidden = S.mode !== 'ideas';
  $id('viewSmart').hidden = S.mode !== 'smart';
  $id('viewMeetings').hidden = S.mode !== 'meetings';
  $id('viewContacts').hidden = S.mode !== 'contacts';
  $id('viewDailyNote').hidden = S.mode !== 'dailynote';
  $id('viewList').hidden = isToday || special || S.view !== 'list';
  $id('viewKanban').hidden = isToday || special || S.view !== 'kanban';
  $id('viewCalendar').hidden = isToday || special || S.view !== 'calendar';
  $id('viewTimeline').hidden = isToday || special || S.view !== 'timeline';
  $id('viewStats').hidden = isToday || special || S.view !== 'stats';
  $id('viewDecisions').hidden = isToday || special || S.view !== 'decisions';
  $id('viewArchive').hidden = isToday || special || S.view !== 'archive';
  if (isToday) renderToday();
  else if (S.mode === 'inbox') renderInbox();
  else if (S.mode === 'ideas') renderIdeas();
  else if (S.mode === 'meetings') renderMeetings();
  else if (S.mode === 'contacts') renderContacts();
  else if (S.mode === 'dailynote') renderDailyNote();
  else if (S.mode === 'smart') renderSmart();
  else if (S.view === 'list') renderList();
  else if (S.view === 'kanban') renderKanban();
  else if (S.view === 'calendar') renderCalendar();
  else if (S.view === 'timeline') renderTimeline();
  else if (S.view === 'decisions') renderDecisions();
  else if (S.view === 'archive') renderArchive();
  else renderStats();
}

function openInbox() { S.mode = 'inbox'; hideQPop(); render(); }
function openIdeas() { S.mode = 'ideas'; render(); }
function openMeetings() { S.mode = 'meetings'; render(); }
function openContacts() { S.mode = 'contacts'; render(); }
function openDailyNote() { S.mode = 'dailynote'; render(); }
function openSmartView(id) { S.mode = 'smart'; S.smartId = id; render(); }
function smartViewById(id) { return S.smartViews.find(v => v.id === id) || null; }

/* ============ 今日聚焦（跨项目） ============ */
function openTodayFocus() {
  S.mode = 'today';
  const p = curProject();
  if (p) S.todayPid = '' + p.id;
  hideQPop();
  render();
}

/* 所有未归档项目中：逾期 / 今天到期 / 进行中的任务，按项目分组 */
function todayGroups() {
  const f = parseFilter(S.search);
  const out = [];
  S.projects.filter(p => !p.archived).forEach(p => {
    let ts = S.tasks.filter(t => t.projectId == p.id && t.status !== 'done' && t.status !== 'wait');
    if (f.owner) ts = ts.filter(t => (t.owner || '').indexOf(f.owner) >= 0);
    if (f.pri) ts = ts.filter(t => (t.pri || 'P1') === f.pri);
    if (f.risk) ts = ts.filter(t => t.risk);
    if (f.rep) ts = ts.filter(t => t.repeat === f.rep);
    if (f.kw) ts = ts.filter(t => (t.title + ' ' + (t.owner || '') + ' ' + p.name).toLowerCase().indexOf(f.kw) >= 0);
    const over = ts.filter(t => t.due < TODAY && t.status !== 'doing').sort(cmpTask);
    const today = ts.filter(t => t.due === TODAY && t.status !== 'doing').sort(cmpTask);
    const doing = ts.filter(t => t.status === 'doing').sort(cmpTask); /* 进行中全部带上，避免漏掉今天到期的 */
    if (over.length || today.length || doing.length) out.push({ p: p, over: over, today: today, doing: doing });
  });
  return out;
}

/* 今日三只青蛙（#7 MIT）：置顶展示 */
function frogBarHtml() {
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  let h = '<div class="frog-bar"><div class="frog-head">🐸 今日三件要事（MIT）';
  h += frogs.length < 3 ? '<span class="frog-hint">从下方任务卡点 🐸 标记，最多 3 件</span>' : '<span class="frog-hint">先吃掉青蛙，再做别的</span>';
  h += '</div><div class="frog-list">';
  h += frogs.map(t =>
    '<div class="frog-item" onclick="openTaskEdit(' + t.id + ')" title="' + esc(projNameOf(t.projectId)) + ' · 点击编辑">'
    + '<b class="fno">' + (S.frogs.ids.indexOf(t.id) + 1) + '</b>'
    + '<span class="ft">' + esc(t.title) + '</span>'
    + '<button class="frog-done" title="标记完成" onclick="event.stopPropagation();setStatus(' + t.id + ',\'done\')">✔</button>'
    + '<button class="frog-rm" title="移出" onclick="event.stopPropagation();toggleFrog(' + t.id + ')">✕</button></div>').join('');
  for (let i = frogs.length; i < 3; i++) h += '<div class="frog-item empty"><b class="fno">' + (i + 1) + '</b><span class="ft">（空）</span></div>';
  h += '</div></div>';
  return h;
}

function renderToday() {
  const groups = todayGroups();
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  if (!groups.length && !frogs.length) {
    $id('viewToday').innerHTML = frogBarHtml() + '<div class="empty" style="padding:60px 0;text-align:center;font-size:14px;">🎉 今天没有到期任务，去「未来 7 天」里提前布局，或者休息一下</div>';
    return;
  }
  let h = frogBarHtml();
  if (!groups.length) {
    $id('viewToday').innerHTML = h;
    return;
  }
  groups.forEach(g => {
    const total = g.over.length + g.today.length + g.doing.length;
    h += '<h2 class="grp">📂 ' + esc(g.p.name) + ' <span class="gcnt">' + total + ' 项</span>'
      + '<button class="linkbtn" onclick="switchProject(' + g.p.id + ')">进入项目 →</button></h2>';
    g.over.forEach(t => { h += cardHtml(t, true); });
    g.today.forEach(t => { h += cardHtml(t, true); });
    g.doing.forEach(t => { h += cardHtml(t, true); });
  });
  $id('viewToday').innerHTML = h;
}

function copyText(text, okMsg) {
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); ok = true; } } catch (e) {}
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    } catch (e) {}
  }
  toast(ok ? okMsg : '复制失败，请手动复制', ok ? 'ok' : 'err');
  return ok;
}

function copyTodayList() {
  const groups = todayGroups();
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  if (!groups.length && !frogs.length) { toast('今天没有可复制的待办', 'info'); return; }
  let n = 0;
  let out = '【今日聚焦】' + TODAY + '\n';
  if (frogs.length) {
    out += '\n🐸 今日三件要事\n';
    frogs.forEach(t => { n++; out += '  ' + (S.frogs.ids.indexOf(t.id) + 1) + '. ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; });
  }
  groups.forEach(g => {
    out += '\n◆ ' + g.p.name + '\n';
    g.over.forEach(t => { if (S.frogs.ids.indexOf(t.id) < 0) { n++; out += '  ⚠ [逾期' + t.due.slice(5) + '] ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; } });
    g.today.forEach(t => { if (S.frogs.ids.indexOf(t.id) < 0) { n++; out += '  ▸ ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; } });
    g.doing.forEach(t => { if (S.frogs.ids.indexOf(t.id) < 0) { n++; out += '  🔨 ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; } });
  });
  copyText(out, '已复制今日清单（' + n + ' 项），去微信/邮件粘贴即可');
}

/* ---------- 列表视图 ---------- */
function dueChipHtml(t) {
  if (t.status === 'done') return '<span class="chip">✔ 完成于 ' + esc(t.doneAt || '') + '</span>';
  let cls = '', label = t.due;
  if (t.due < TODAY) { cls = 'due-over'; label = '逾期 ' + t.due; }
  else if (t.due === TODAY) { cls = 'due-today'; label = '今天到期'; }
  else {
    const diff = daysDiff(t.due);
    label = t.due + '（还剩 ' + diff + ' 天）';
  }
  return '<span class="chip ' + cls + '">📆 ' + esc(label) + '</span>';
}
function cardHtml(t, showProj) {
  const cls = 'card' + (t.risk && t.status !== 'done' ? ' risk' : '') + (t.status === 'wait' ? ' wait' : '')
    + (t.status === 'doing' ? ' doing' : '') + (t.status === 'done' ? ' done' : '') + (t.sortOrder < 0 ? ' pinned' : '')
    + (riskValue(t) >= RISK_RED && isOpen(t) ? ' risk-high' : '');
  const st = [['todo', '待办'], ['doing', '进行中'], ['wait', '等待'], ['done', '完成']];
  const btns = st.map(pp => '<button class="' + (t.status === pp[0] ? 'on' : '') + '" onclick="setStatus(' + t.id + ',\'' + pp[0] + '\')">' + pp[1] + '</button>').join('');
  const cl = checklistSummary(t);
  const roll = rollupSummary(t);
  const clChip = roll ? '<span class="chip clprog">☑ ' + roll.done + '/' + roll.total + (roll.subs ? ' 子' + roll.subs : '') + '</span>' : '';
  const pinChip = t.sortOrder < 0 ? '<span class="chip pinchip">📌 置顶</span>' : '';
  const repChip = t.repeat ? '<span class="chip">🔄 ' + repeatLabel(t.repeat) + '</span>' : '';
  const stale = staleDays(t);
  const staleChip = (t.status !== 'done' && stale >= 7) ? '<span class="chip stale" title="超过 7 天没有任何更新，考虑清理、改期或升级">💤 停滞 ' + stale + ' 天</span>' : '';
  const projChip = showProj ? '<span class="chip projchip">📂 ' + esc(projNameOf(t.projectId)) + '</span>' : '';
  const rv = riskValue(t);
  const riskChip = t.risk && isOpen(t)
    ? '<span class="chip risk' + (rv >= RISK_RED ? ' riskred' : '') + '" title="' + (rv ? '风险值 ' + rv + '（概率' + t.riskProb + '×影响' + t.riskImpact + '）' : '未评分，编辑里完善概率/影响') + '">⚠ ' + (rv ? 'R' + rv : '风险') + '</span>'
    : '';
  const deferChip = (t.status !== 'done' && (t.deferCount || 0) >= 3)
    ? '<span class="chip defer" title="已连续推迟 ' + t.deferCount + ' 次：删 / 改期 / 升级，三选一">⚠ 已推迟 ' + t.deferCount + ' 次</span>' : '';
  const frogChip = S.frogs.ids.indexOf(t.id) >= 0 ? '<span class="chip frogchip" title="今日三件要事">🐸 要事 ' + (S.frogs.ids.indexOf(t.id) + 1) + '</span>' : '';
  const timing = S.timer && S.timer.taskId == t.id ? '<span class="chip timing">⏱ 计时中 ' + timerText(S.timer.startedAt) + '</span>' : '';
  const parent = t.parentId ? getTask(t.parentId) : null;
  const parentChip = parent ? '<span class="chip parentchip" title="父任务：' + esc(parent.title) + '">↳ ' + esc(parent.title.slice(0, 10)) + '</span>' : '';
  const open = t.status !== 'done';
  return '<div class="' + cls + '">'
    + '<button class="ccircle ' + (t.status === 'done' ? 'on' : '') + '" title="点击完成/恢复" onclick="toggleDone(' + t.id + ')"></button>'
    + '<div class="cbody">'
    + '<div class="title" onclick="openTaskEdit(' + t.id + ')">' + esc(t.title) + '</div>'
    + (roll && roll.total && open ? '<div class="kbar"><i style="width:' + Math.round(roll.done / roll.total * 100) + '%"></i></div>' : '')
    + '<div class="meta">' + projChip + dueChipHtml(t)
    + '<span class="chip ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : '')) + '">' + esc(t.pri || 'P1') + '</span>'
    + '<span class="chip">👤 ' + esc(t.owner || '我方') + '</span>'
    + riskChip
    + repChip
    + clChip + staleChip + deferChip + frogChip + timing + pinChip + parentChip
    + '</div>'
    + (t.note ? '<div class="note mdview-inline">' + mdRender(t.note) + '</div>' : '')
    + (open && t.risk && (t.riskMitigate || t.riskEscalate) ? '<div class="note">🛡 ' + esc(t.riskMitigate || '（未填应对措施）') + (t.riskEscalate ? ' ｜ 升级条件：' + esc(t.riskEscalate) : '') + '</div>' : '')
    + '<div class="acts">' + btns
    + '<span class="spacer"></span>'
    + '<span class="more-wrap"><button class="more-btn" title="更多操作：计时 / 推迟 / 要事 / 置顶 / 删除" onclick="toggleCardMenu(event,' + t.id + ')">⋯</button>'
    + '<div class="menu-pop card-menu" hidden></div></span></div>'
    + '</div></div>';
}
async function toggleDone(id) {
  const t = getTask(id); if (!t) return;
  await setStatus(id, t.status === 'done' ? 'todo' : 'done');
}
/* 任务卡 ⋯ 菜单（v2.1）：低频操作收进二级菜单，卡片默认只留状态切换 + ⋯，打开时按任务最新状态重建内容 */
function cardMenuHtml(t) {
  if (!t) return '';
  const open = t.status !== 'done';
  const timing = S.timer && S.timer.taskId == t.id;
  const frog = S.frogs.ids.indexOf(t.id) >= 0;
  let h = '';
  if (open) {
    h += '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'timer\')">' + (timing ? '⏹ 停止计时' : '⏱ 开始计时（计入工时）') + '</button>'
      + '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'snooze\')">⏭ 推迟到明天</button>'
      + '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'frog\')">' + (frog ? '🐸 移出今日要事' : '🐸 设为今日要事') + '</button>';
  }
  h += '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'pin\')">' + (t.sortOrder < 0 ? '📌 取消置顶' : '📌 置顶') + '</button>'
    + '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'edit\')">✎ 编辑详情</button>'
    + '<div class="menu-sep"></div>'
    + '<button class="danger" onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'del\')">🗑 删除（可在回收站恢复）</button>';
  return h;
}
function toggleCardMenu(e, id) {
  const wrap = e.currentTarget.closest('.more-wrap');
  const menu = wrap.querySelector('.card-menu');
  const show = menu.hidden;
  closeCardMenus();
  if (show) { menu.innerHTML = cardMenuHtml(getTask(id)); menu.hidden = false; }
}
function closeCardMenus() { document.querySelectorAll('.card-menu').forEach(m => { m.hidden = true; }); }
async function cardMenuAct(id, act) {
  closeCardMenus();
  if (act === 'timer') toggleTimer(id);
  else if (act === 'snooze') snoozeTask(id);
  else if (act === 'frog') toggleFrog(id);
  else if (act === 'pin') togglePin(id);
  else if (act === 'edit') openTaskEdit(id);
  else if (act === 'del') delTaskById(id, true);
}
/* 列表富空状态（v2.1）：区分「真没任务」与「筛选无结果」，给出下一步动作 */
function listEmptyHtml() {
  const kw = (S.search || '').trim();
  if (kw) {
    return '<div class="empty-state"><div class="es-icon">🔍</div>'
      + '<div class="es-title">没有匹配「' + esc(kw) + '」的任务</div>'
      + '<div class="es-hint">换个更短的关键词，或清除筛选查看全部任务</div>'
      + '<div class="es-actions"><button class="btn ghost" onclick="clearSearch()">🧹 清除筛选</button></div></div>';
  }
  return '<div class="empty-state"><div class="es-icon">🚀</div>'
    + '<div class="es-title">这个项目还没有任务</div>'
    + '<div class="es-hint">在上方输入框用自然语言快速添加，回车即可：</div>'
    + '<div class="es-syntax"><code>下周三 联调测试 @李四 !P0 #风险</code></div>'
    + '<div class="es-legend">📅 今天 / 明天 / 下周三 / +3天 ｜ 👤 @负责人 ｜ ⚡ 优先级 !P0 !P1 !P2 ｜ 标记 #风险 #每日 #每周 #每月</div>'
    + '<div class="es-actions"><button class="btn blue" onclick="focusQuickAdd()">⌨ 快速添加</button>'
    + '<button class="btn ghost" onclick="openTaskEdit(0)">＋ 详细新建</button>'
    + '<button class="btn ghost" onclick="quickAddFromClipboard()">📌 从剪贴板导入</button></div>'
    + '<div class="es-hint">批量导入：右上「⋯ 项目工具」→ Excel 计划表导入向导</div></div>';
}
function clearSearch() {
  S.search = '';
  $id('search').value = '';
  renderView();
}
function focusQuickAdd() {
  const q = $id('quick');
  if (!q) return;
  q.focus();
  q.scrollIntoView({ block: 'nearest' });
}
function renderList() {
  const ts = filteredTasks();
  if (!ts.length) { $id('viewList').innerHTML = listEmptyHtml(); return; }
  const weekEnd = addDays(TODAY, 7);
  const g = { today: [], week: [], later: [], wait: [], done: [] };
  ts.forEach(t => {
    if (t.status === 'done') { g.done.push(t); return; }
    if (t.status === 'wait') { g.wait.push(t); return; }
    if (t.due <= TODAY) g.today.push(t);
    else if (t.due <= weekEnd) g.week.push(t);
    else g.later.push(t);
  });
  g.today.sort(cmpTask); g.week.sort(cmpTask); g.later.sort(cmpTask);
  g.done.sort((a, b) => (b.doneAt || '') > (a.doneAt || '') ? 1 : -1);

  let h = '';
  h += '<h2 class="grp">🔴 今天到期 / 已逾期 <span class="gcnt">' + g.today.length + '</span></h2>';
  h += g.today.length ? g.today.map(cardHtml).join('') : '<div class="empty">无</div>';
  h += '<h2 class="grp">🟠 未来 7 天 <span class="gcnt">' + g.week.length + '</span></h2>';
  h += g.week.length ? g.week.map(cardHtml).join('') : '<div class="empty">无</div>';
  h += '<h2 class="grp">⚪ 更远 <span class="gcnt">' + g.later.length + '</span></h2>';
  h += g.later.length ? g.later.map(cardHtml).join('') : '<div class="empty">无</div>';
  h += '<h2 class="grp">⏳ 等人 / 等外部 <span class="gcnt">' + g.wait.length + '</span> —— 到点没回复就升级</h2>';
  h += g.wait.length ? g.wait.map(cardHtml).join('') : '<div class="empty">无</div>';
  h += '<details class="grp-done"><summary>✅ 已完成 <span class="gcnt">' + g.done.length + '</span></summary>';
  h += g.done.slice(0, 80).map(cardHtml).join('') + '</details>';
  $id('viewList').innerHTML = h;
}

/* ---------- 看板视图 ---------- */
const KANBAN_COLS = [['todo', '📥 待办', '#7b849e'], ['doing', '🔨 进行中', '#4c6ef5'], ['wait', '⏳ 等待', '#f08c00'], ['done', '✅ 已完成', '#2f9e44']];
const WIP_LIMIT = 5; /* 进行中超过此数亮黄提示（Jira kanban WIP limit 实践） */
function renderKanban() {
  const p = curProject();
  const sle = p ? sleP85Days(p.id) : null; /* 包1 #3：历史 cycle time 85 分位做离群线 */
  const ts = filteredTasks();
  let h = '';
  if (sle) {
    h += '<div class="sle-note" title="ActionableAgile SLE：最近完成的任务从开始到完成的 85 分位时长">📏 SLE：85% 的任务在 ' + sle.p85 + ' 天内完成（近 ' + sle.n + ' 条样本）；进行中超过该时长标红</div>';
  }
  KANBAN_COLS.forEach(col => {
    const cards = ts.filter(t => t.status === col[0]).sort(cmpTask);
    const wipOver = col[0] === 'doing' && cards.length > WIP_LIMIT;
    h += '<div class="kcol" data-status="' + col[0] + '">'
      + '<div class="khead"><span class="kdot" style="background:' + col[2] + '"></span>' + col[1]
      + '<span class="kcnt">' + cards.length + '</span>'
      + (wipOver ? '<span class="wipwarn" title="WIP 限制：进行中别超过 ' + WIP_LIMIT + ' 项，先完成再开始">⚠ 超过 ' + WIP_LIMIT + ' 项</span>' : '')
      + '</div>'
      + (cards.length ? cards.map(t => {
          const roll = rollupSummary(t);
          const stale = staleDays(t);
          const pct = roll && roll.total ? Math.round(roll.done / roll.total * 100) : 0;
          return '<div class="kcard ' + (t.sortOrder < 0 ? 'pinned' : '') + (riskValue(t) >= RISK_RED && isOpen(t) ? ' risk-high' : '') + '" data-id="' + t.id + '" onclick="openTaskEdit(' + t.id + ')">'
          + '<div class="kt">' + (t.sortOrder < 0 ? '📌 ' : '') + (S.frogs.ids.indexOf(t.id) >= 0 ? '🐸 ' : '') + esc(t.title) + '</div>'
          + (roll && roll.total && t.status !== 'done' ? '<div class="kbar"><i style="width:' + pct + '%"></i></div>' : '')
          + '<div class="km">' + dueChipHtml(t)
          + '<span class="chip ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : '')) + '">' + esc(t.pri || 'P1') + '</span>'
          + '<span class="chip">👤 ' + esc(t.owner || '我方') + '</span>'
          + (t.risk ? '<span class="chip risk' + (riskValue(t) >= RISK_RED ? ' riskred' : '') + '">' + (riskValue(t) ? '⚠R' + riskValue(t) : '⚠') + '</span>' : '')
          + (t.repeat ? '<span class="chip">🔄</span>' : '')
          + (t.status !== 'done' && stale >= 7 ? '<span class="chip stale">💤' + stale + '天</span>' : '')
          + (t.status === 'doing' && sle && wipAgeDays(t) > sle.p85 ? '<span class="chip aging-red" title="WIP Aging：在制 ' + wipAgeDays(t) + ' 天已超过 SLE 85 分位（' + sle.p85 + ' 天），大概率离群，考虑拆分/升级/砍范围">⏳ WIP ' + wipAgeDays(t) + ' 天 &gt; SLE</span>' : '')
          + (t.status !== 'done' && (t.deferCount || 0) >= 3 ? '<span class="chip defer">⚠推迟' + t.deferCount + '次</span>' : '')
          + (S.timer && S.timer.taskId == t.id ? '<span class="chip timing">⏱</span>' : '')
          + (roll ? '<span class="chip clprog">☑ ' + roll.done + '/' + roll.total + (roll.subs ? ' 子' + roll.subs : '') + '</span>' : '')
          + '</div></div>';
        }).join('')
        : '<div class="empty">把卡片拖到这里</div>')
      + '</div>';
  });
  $id('viewKanban').innerHTML = h;
}

/* ---------- 看板：指针拖拽（自实现，替代 HTML5 DnD，WebView2/浏览器行为一致） ---------- */
let kdrag = null;              // { id, srcEl, started, startX, startY, ghost, offsetY, hoverCol }
let kanbanSuppressClickUntil = 0;

function bindKanbanDrag() {
  document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const card = e.target.closest ? e.target.closest('.kcard') : null;
    if (!card || !card.getAttribute) return;
    const id = +card.getAttribute('data-id');
    if (!id || !getTask(id)) return;
    kdrag = { id, srcEl: card, started: false, startX: e.clientX, startY: e.clientY, ghost: null, hoverCol: null, offsetY: 20 };
    e.preventDefault(); // 阻止原生文字拖选，由我们自己判定拖拽
  });
  document.addEventListener('mousemove', e => {
    if (!kdrag) return;
    if (!kdrag.started) {
      if (Math.abs(e.clientX - kdrag.startX) < 5 && Math.abs(e.clientY - kdrag.startY) < 5) return;
      startKanbanGhost(e);
    }
    moveKanbanGhost(e);
    highlightKanbanCol(e);
    e.preventDefault();
  });
  document.addEventListener('mouseup', e => {
    if (!kdrag) return;
    const d = kdrag;
    kdrag = null;
    document.body.classList.remove('dragging-card');
    if (!d.started) return; // 未超过阈值 = 普通点击，正常打开编辑
    kanbanSuppressClickUntil = Date.now() + 400;
    if (d.ghost) d.ghost.remove();
    if (d.srcEl) d.srcEl.classList.remove('drag-src');
    if (d.hoverCol) d.hoverCol.classList.remove('drop');
    const col = kanbanColAt(e.clientX, e.clientY);
    if (col) {
      const status = col.getAttribute('data-status');
      const t = getTask(d.id);
      if (t && t.status !== status) setStatus(d.id, status);
    }
  });
}
function kanbanColAt(x, y) {
  const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  for (const el of stack) {
    const col = el.closest ? el.closest('.kcol') : null;
    if (col) return col;
  }
  return null;
}
function startKanbanGhost(e) {
  kdrag.started = true;
  const rect = kdrag.srcEl.getBoundingClientRect();
  kdrag.offsetY = Math.min(24, e.clientY - rect.y);
  const ghost = kdrag.srcEl.cloneNode(true);
  ghost.className = 'kcard kdrag-ghost';
  ghost.style.width = rect.width + 'px';
  ghost.style.left = (e.clientX - rect.width / 2) + 'px';
  ghost.style.top = (e.clientY - kdrag.offsetY) + 'px';
  document.body.appendChild(ghost);
  kdrag.ghost = ghost;
  kdrag.srcEl.classList.add('drag-src');
  document.body.classList.add('dragging-card');
}
function moveKanbanGhost(e) {
  if (!kdrag.ghost) return;
  kdrag.ghost.style.left = (e.clientX - kdrag.ghost.getBoundingClientRect().width / 2) + 'px';
  kdrag.ghost.style.top = (e.clientY - kdrag.offsetY) + 'px';
}
function highlightKanbanCol(e) {
  const col = kanbanColAt(e.clientX, e.clientY);
  if (kdrag.hoverCol && kdrag.hoverCol !== col) kdrag.hoverCol.classList.remove('drop');
  if (col && kdrag.hoverCol !== col) col.classList.add('drop');
  kdrag.hoverCol = col;
}

/* ---------- 统计视图 ---------- */
async function renderStats() {
  const p = curProject(); if (!p) return;
  const seq = ++statsSeq; /* await 后若已发起更新一次统计渲染，丢弃本次结果避免旧数据覆盖 */
  const ts = projTasks(p.id);
  const open = ts.filter(t => t.status !== 'done');
  const done = ts.filter(t => t.status === 'done');
  const overdue = open.filter(t => t.status !== 'wait' && t.due < TODAY).length;
  const risks = open.filter(t => t.risk).length;
  const highRisks = open.filter(t => riskValue(t) >= RISK_RED).length;
  const wk = addDays(TODAY, -6);
  const wkDone = done.filter(t => t.doneAt && t.doneAt >= wk && t.doneAt <= TODAY).length;
  const rate = ts.length ? Math.round(done.length / ts.length * 100) : 0;

  let h = '<div class="stat-grid">'
    + statCard(ts.length, '总事项', 'c-blue') + statCard(done.length, '已完成', 'c-green')
    + statCard(open.filter(t => t.status === 'doing').length, '进行中', 'c-teal')
    + statCard(overdue, '已逾期', 'c-red') + statCard(risks, '开放风险', 'c-red')
    + statCard(highRisks, '高危风险 R≥' + RISK_RED, 'c-red')
    + statCard(rate + '%', '完成率', 'c-blue') + '</div>';

  h += '<div class="stat-panel"><h3>📈 近 7 天完成趋势</h3><div class="bars">';
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(TODAY, -i);
    days.push({ d: d, n: done.filter(t => t.doneAt === d).length });
  }
  const maxN = Math.max(1, ...days.map(x => x.n));
  days.forEach(x => {
    h += '<div class="bar-col"><span class="bv">' + (x.n || '') + '</span>'
      + '<div class="bar" style="height:' + Math.max(3, Math.round(x.n / maxN * 100)) + '%"></div>'
      + '<span class="bl">' + x.d.slice(5) + '</span></div>';
  });
  h += '</div></div>';

  const byOwner = {};
  open.forEach(t => { const o = t.owner || '我方'; byOwner[o] = (byOwner[o] || 0) + 1; });
  const owners = Object.keys(byOwner).sort((a, b) => byOwner[b] - byOwner[a]);
  const maxO = Math.max(1, ...owners.map(o => byOwner[o]));
  h += '<div class="stat-panel"><h3>👥 负责人未完成负载</h3>';
  h += owners.length ? owners.map(o =>
    '<div class="hbar-row"><span class="hl">' + esc(o) + '</span><div class="htrack"><div class="hbar" style="width:' + Math.round(byOwner[o] / maxO * 100) + '%"></div></div><span class="hv">' + byOwner[o] + '</span></div>').join('')
    : '<div class="empty">暂无未完成任务</div>';
  h += '</div>';

  const priCnt = { P0: 0, P1: 0, P2: 0 };
  open.forEach(t => { const k = PRI_W[t.pri || 'P1'] != null ? t.pri || 'P1' : 'P1'; priCnt[k]++; });
  const priRows = [['P0', priCnt.P0, 'red'], ['P1', priCnt.P1, 'orange'], ['P2', priCnt.P2, '']];
  const maxP = Math.max(1, priCnt.P0, priCnt.P1, priCnt.P2);
  h += '<div class="stat-panel"><h3>🚦 未完成任务优先级分布</h3>';
  h += priRows.map(r =>
    '<div class="hbar-row ' + r[2] + '"><span class="hl">' + r[0] + '</span><div class="htrack"><div class="hbar" style="width:' + Math.round(r[1] / maxP * 100) + '%"></div></div><span class="hv">' + r[1] + '</span></div>').join('');
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
  const overRate = openActive.length ? Math.round(openActive.filter(t => t.due < TODAY).length / openActive.length * 100) : 0;
  h += '<div class="stat-panel"><h3>⏱ 周期统计（Cycle Time，参考 Linear / Azure DevOps）</h3><div>'
    + '<span class="chip2 cd">平均处理时长：' + (avgCyc != null ? avgCyc + ' 天（' + cycDays.length + ' 条有开始记录）' : '暂无数据：把任务切到「进行中」开始积累') + '</span>'
    + '<span class="chip2 ' + (overRate >= 30 ? 'bad' : '') + '">未完成任务逾期率：' + overRate + '%</span>'
    + '</div>';
  const weeks = [];
  for (let i = 3; i >= 0; i--) {
    const ws = addDays(TODAY, -(i * 7 + 6)), we = addDays(TODAY, -i * 7);
    const wc = done.filter(t => t.doneAt && t.doneAt >= ws && t.doneAt <= we);
    const wover = wc.filter(t => t.due < t.doneAt).length;
    weeks.push({ label: ws.slice(5) + '~' + we.slice(5), n: wc.length, pct: wc.length ? Math.round(wover / wc.length * 100) : null });
  }
  h += '<div class="bars small">' + weeks.map(w2 =>
    '<div class="bar-col"><span class="bv">' + (w2.pct == null ? '—' : w2.pct + '%') + '</span>'
    + '<div class="bar ' + (w2.pct != null && w2.pct >= 30 ? 'bad' : '') + '" style="height:' + (w2.pct == null ? 3 : Math.max(4, w2.pct)) + '%"></div>'
    + '<span class="bl">' + w2.label + '</span></div>').join('') + '</div>';
  h += '<div class="empty" style="padding:4px 0;">近 4 周每周完成任务的「逾期率」（完成时已过截止日占比）</div></div>';

  /* 本周投入工时（#1，跨项目汇总） */
  try {
    const logs = await invoke('get_time_logs', { since: wk });
    if (logs && logs.length) {
      const byProj = {};
      logs.forEach(l => {
        const k = l.projectId || 0;
        byProj[k] = (byProj[k] || 0) + (l.minutes || 0);
        byProj['@' + k] = (byProj['@' + k] || 0) + 1;
      });
      const keys = Object.keys(byProj).filter(k => k[0] !== '@').sort((a, b) => byProj[b] - byProj[a]);
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

  /* ---------- 包1：蒙特卡洛交付预测（#1） ---------- */
  const openCnt = open.filter(t => t.status !== 'wait').length;
  h += '<div class="stat-panel"><h3>🎯 交付预测（蒙特卡洛 · Vacanti/Magennis）——回答「哪天交付」</h3>';
  if (thr.total < 3) {
    h += '<div class="empty">需要至少 3 条已完成任务的历史（完成日期）才能模拟；先正常用「✔」勾完成积累 2-3 周数据。<br>当前该项目完成 <b>' + thr.total + '</b> 条、剩余 <b>' + openCnt + '</b> 条。</div>';
  } else {
    h += '<div class="fc-row"><label style="margin:0;">剩余任务数</label><input type="number" id="fc-remaining" min="1" value="' + Math.max(1, openCnt) + '" style="width:90px;">'
      + '<button class="btn blue" onclick="runForecast()">🔮 预测</button><span id="fc-basis" class="hint"></span></div>'
      + '<div id="fc-result">' + forecastHtml(monteCarloForecast(p.id, Math.max(1, openCnt)), openCnt) + '</div>';
  }
  h += '</div>';

  /* ---------- 包1：工时预算告警（#4） ---------- */
  const stt = parseSettings(p);
  let budgetHtml = '<div class="empty">尚未设置预算：点项目名打开设置，填写「工时预算（小时）」。</div>';
  if (stt.budgetHours > 0) {
    try {
      const logs = await invoke('get_time_logs', { since: '2000-01-01' }) || [];
      const used = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
      const pct = Math.min(100, Math.round(used / stt.budgetHours * 100));
      const burnWk = logs.filter(l => l.projectId == p.id && l.date >= wk).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
      const remain = Math.max(0, stt.budgetHours - used);
      const weeksLeft = burnWk > 0.05 ? (remain / burnWk) : null;
      budgetHtml = '<div class="hbar-row"><span class="hl">已用 / 预算</span><div class="htrack"><div class="hbar ' + (pct >= 100 ? 'red' : pct >= 80 ? 'orange' : '') + '" style="width:' + pct + '%"></div></div><span class="hv">' + pct + '%</span></div>'
        + '<div class="chips-line"><span class="chip2 ' + (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'good') + '">⏳ ' + used.toFixed(1) + ' / ' + stt.budgetHours + ' 小时</span>'
        + '<span class="chip2">近 7 天燃烧 ' + burnWk.toFixed(1) + 'h/周</span>'
        + '<span class="chip2 ' + (weeksLeft != null && weeksLeft < 2 ? 'bad' : '') + '">' + (weeksLeft != null ? '照此速率约 ' + (weeksLeft < 0.2 ? '本周内' : weeksLeft.toFixed(1) + ' 周') + '用完剩余 ' + remain.toFixed(1) + 'h' : '近 7 天无投入') + '</span></div>'
        + '<div class="empty" style="padding:2px 0;">告警阈值 80%/100%：触发时走系统托盘通知' + (stt.webhook && stt.webhook.url ? ' + 群推送' : '') + '；日报自动附燃烧率。</div>';
    } catch (e) {}
  }
  h += '<div class="stat-panel"><h3>🧮 工时预算（Toggl Alerts）——回答「花了多少」</h3>' + budgetHtml + '</div>';

  /* ---------- 包1：SLE 分位（#3） ---------- */
  const sle = sleP85Days(p.id);
  h += '<div class="stat-panel"><h3>📏 SLE 分位阈值（ActionableAgile）</h3>';
  h += sle
    ? '<div class="chips-line"><span class="chip2 cd">85% 的任务 ≤ ' + sle.p85 + ' 天完成</span><span class="chip2">样本 ' + sle.n + ' 条（有「进行中→完成」记录的任务）</span><span class="chip2">看板里 WIP 超过 ' + sle.p85 + ' 天的卡片标红</span></div>'
    : '<div class="empty">样本不足（需要 ≥5 条有开始/完成记录的任务）。把任务切到「进行中」再完成即可积累。</div>';
  h += '</div>';

  if (seq !== statsSeq) return; /* 中途有 await，若期间已再次触发渲染则丢弃本次结果 */
  $id('viewStats').innerHTML = h;
}
/* 预测结果：三行置信表 + 直方图 + 可转发群的话术 */
function forecastHtml(fc, openCnt) {
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
    const maxP = Math.max(...hist.map(x => x.p));
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
async function runForecast() {
  const p = curProject(); if (!p) return;
  const n = Math.max(1, +$id('fc-remaining').value || 1);
  const fc = monteCarloForecast(p.id, n);
  const box = $id('fc-result');
  if (box) box.innerHTML = forecastHtml(fc, n);
}
function statCard(v, label, color) {
  return '<div class="stat-card ' + color + '"><div class="sv">' + v + '</div><div class="sl">' + label + '</div></div>';
}

/* ---------- 日历视图（当前项目月历，看截止日扎堆） ---------- */
function renderCalendar() {
  const p = curProject(); if (!p) return;
  if (!S.calMonth) S.calMonth = TODAY.slice(0, 7);
  const parts = S.calMonth.split('-');
  const y = +parts[0], m = +parts[1];
  const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7; // 周一=0
  const dim = new Date(y, m, 0).getDate();
  const prevYm = m === 1 ? (y - 1) + '-12' : y + '-' + pad(m - 1);
  const nextYm = m === 12 ? (y + 1) + '-01' : y + '-' + pad(m + 1);

  const byDay = {};
  projTasks(p.id).forEach(t => {
    if (!t.due || t.due.slice(0, 7) !== S.calMonth) return;
    (byDay[t.due] = byDay[t.due] || []).push(t);
  });

  /* 循环任务预占（#15）：每周/每月循环在当月的下一次及后续占位 */
  const monthEnd = y + '-' + pad(m) + '-' + pad(dim);
  const ghosts = {};
  projTasks(p.id).forEach(t => {
    if (t.status === 'done' || !t.repeat || !t.due) return;
    let cur = t.due;
    let guard = 0;
    while (cur <= monthEnd && guard++ < 62) {
      if (cur > t.due && cur >= y + '-' + pad(m) + '-01' && cur <= monthEnd) {
        (ghosts[cur] = ghosts[cur] || []).push(t);
      }
      cur = t.repeat === 'daily' ? addDays(cur, 1)
        : t.repeat === 'weekly' ? addDays(cur, 7)
        : addMonths(cur, 1);
    }
  });

  const wkChars = ['一', '二', '三', '四', '五', '六', '日'];
  let h = '<div class="cal-head">'
    + '<button class="btn ghost" onclick="calNav(-1)">‹</button>'
    + '<b class="cal-title">' + y + ' 年 ' + m + ' 月</b>'
    + '<button class="btn ghost" onclick="calNav(1)">›</button>'
    + '<button class="btn ghost" onclick="calGoToday()">今天</button>'
    + '<span class="flex1"></span>'
    + '<span class="chip2">📆 ' + esc(p.name) + ' · 本月 ' + Object.keys(byDay).reduce((s, d) => s + byDay[d].length, 0) + ' 项截止</span>'
    + '</div>';
  h += '<div class="cal-grid">';
  wkChars.forEach(c => { h += '<div class="cal-wk">' + c + '</div>'; });
  for (let i = 0; i < firstDow; i++) h += '<div class="cal-cell blank"></div>';
  for (let d = 1; d <= dim; d++) {
    const ds = y + '-' + pad(m) + '-' + pad(d);
    const items = (byDay[ds] || []).sort(cmpTask);
    const gs = (ghosts[ds] || []);
    const isToday = ds === TODAY;
    let cells = '';
    items.slice(0, 3).forEach(t => {
      const doneCls = t.status === 'done' ? ' done' : '';
      const overCls = (t.status !== 'done' && t.due < TODAY) ? ' over' : '';
      cells += '<div class="cal-task' + doneCls + overCls + '" title="' + esc(t.title) + '（' + (t.owner || '我方') + ' · ' + esc(t.pri || 'P1') + '）" onclick="event.stopPropagation();openTaskEdit(' + t.id + ')">'
        + '<i class="pdot ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : 'p2')) + '"></i>' + esc(t.title) + '</div>';
    });
    if (items.length > 3) cells += '<div class="cal-more">…还有 ' + (items.length - 3) + ' 项</div>';
    gs.slice(0, items.length > 3 ? 1 : Math.max(0, 3 - items.length)).forEach(t => {
      cells += '<div class="cal-task ghost" title="循环任务预占：' + esc(t.title) + '（' + repeatLabel(t.repeat) + '）—— 到期未完成会自动顺延" onclick="event.stopPropagation();openTaskEdit(' + t.id + ')">🔄 ' + esc(t.title) + '</div>';
    });
    if (gs.length > 3 - Math.min(items.length, 3) && items.length <= 3) cells += '<div class="cal-more">…还有 ' + (gs.length - Math.max(0, 3 - items.length)) + ' 次预占</div>';
    const dcnt = items.length + gs.length;
    h += '<div class="cal-cell' + (isToday ? ' today' : '') + '">'
      + '<div class="cal-d">' + d + (dcnt ? ' <span class="cal-n">' + dcnt + '</span>' : '') + '</div>'
      + cells + '</div>';
  }
  h += '</div>';
  h += '<div class="cal-legend"><span class="chip2"><i class="pdot p0"></i>P0</span><span class="chip2"><i class="pdot p1"></i>P1</span><span class="chip2"><i class="pdot p2"></i>P2</span><span class="chip2">🔄 虚块 = 循环任务预占（Reclaim 思路简化版）</span><span class="chip2">点任务直接编辑</span></div>';
  $id('viewCalendar').innerHTML = h;
}
function calNav(delta) {
  const parts = S.calMonth.split('-');
  const d = new Date(+parts[0], +parts[1] - 1 + delta, 1);
  S.calMonth = d.getFullYear() + '-' + pad(d.getMonth() + 1);
  renderView();
}
function calGoToday() { S.calMonth = TODAY.slice(0, 7); renderView(); }

/* ============ 任务编辑弹窗（含检查清单 / 风险登记册 / 父任务） ============ */
let editChecklist = [];
function openTaskEdit(id) {
  if (Date.now() < kanbanSuppressClickUntil) return; // 拖拽刚结束，忽略误触点击
  const isNew = !id;
  const newPid = (S.mode === 'today' && $id('qProj') && !$id('qProj').hidden && $id('qProj').value) ? +$id('qProj').value : curProject().id;
  const t = isNew
    ? { id: 0, projectId: newPid, title: '', due: TODAY, owner: '我方', pri: 'P1', status: 'todo', doneAt: '', risk: false, repeat: '', note: '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]', deferCount: 0, riskProb: 0, riskImpact: 0, riskMitigate: '', riskEscalate: '', doingSince: '', parentId: 0, startDate: '', isMilestone: false }
    : getTask(id);
  if (!t) return;
  editingTaskId = t.id;
  $id('tm-head').textContent = isNew ? '新增事项' : '编辑事项';
  $id('m-title').value = t.title;
  $id('m-due').value = t.due;
  $id('m-start').value = t.startDate || '';
  $id('m-owner').value = t.owner || '';
  $id('m-pri').value = t.pri || 'P1';
  $id('m-status').value = t.status;
  $id('m-risk').checked = !!t.risk;
  $id('m-milestone').checked = !!t.isMilestone;
  $id('m-repeat').value = t.repeat || '';
  $id('m-note').value = t.note || '';
  $id('m-prob').value = String(t.riskProb || 0);
  $id('m-impact').value = String(t.riskImpact || 0);
  $id('m-mitigate').value = t.riskMitigate || '';
  $id('m-escalate').value = t.riskEscalate || '';
  $id('m-note-preview').hidden = true;
  $id('m-note-preview-toggle').textContent = '👁 预览渲染效果';
  /* 父任务选择：同项目其他任务（排除自己与自己的子任务，避免环） */
  const pidNow = isNew ? newPid : t.projectId;
  const exclude = isNew ? [] : [t.id].concat(allDescendantIds(t.id)); /* 排除自己+整棵子树，避免选中孙任务成环 */
  const opts = projTasks(pidNow).filter(x => exclude.indexOf(x.id) < 0 && x.status !== 'done');
  $id('m-parent').innerHTML = '<option value="0">（无父任务）</option>' + opts.map(x =>
    '<option value="' + x.id + '"' + (t.parentId == x.id ? ' selected' : '') + '>' + esc(x.title.slice(0, 30)) + '</option>').join('');
  $id('m-del').style.display = isNew ? 'none' : '';
  editChecklist = parseChecklist(t).map(x => ({ text: x.text, done: !!x.done }));
  renderChecklistEditor();
  updateRiskEditor();
  renderBacklinks(t);
  openModal('mw-task');
  $id('m-title').focus();
}
/* 包4 #14：详情页显示「哪些任务/决策提到过它」 */
function renderBacklinks(t) {
  if (t.id <= 0) { $id('m-backlinks').hidden = true; return; }
  const links = backlinksOf(t.title);
  const box = $id('m-backlinks');
  if (!links.length) { box.hidden = true; return; }
  box.innerHTML = '<div class="bl-title">🔗 被引用（' + links.length + '）</div>' + links.map(l =>
    '<span class="bl-item" onclick="jumpBacklink(\'' + l.kind + '\',' + l.id + ')">' + esc(l.label) + ' <i>' + esc(l.sub) + '</i></span>').join('');
  box.hidden = false;
}
function jumpBacklink(kind, id) {
  closeModal('mw-task');
  if (kind === 'task') {
    const t = getTask(id);
    if (t) { S.cur = '' + t.projectId; S.mode = 'project'; render(); openTaskEdit(id); }
  } else if (kind === 'decision') {
    const d = S.decisions.find(x => x.id == id);
    if (d) { if (d.projectId) switchProject(d.projectId); S.mode = 'project'; S.view = 'decisions'; render(); }
  } else if (kind === 'meeting') {
    S.mode = 'meetings'; render();
  } else if (kind === 'project') {
    if (S.projects.some(p => p.id == id)) { switchProject(id); S.view = 'archive'; render(); }
  }
}
function toggleNotePreview() {
  const pv = $id('m-note-preview');
  if (pv.hidden) {
    pv.innerHTML = mdRender($id('m-note').value || '（空）');
    pv.hidden = false;
    $id('m-note-preview-toggle').textContent = '✏️ 返回编辑';
  } else {
    pv.hidden = true;
    $id('m-note-preview-toggle').textContent = '👁 预览渲染效果';
  }
}
function updateRiskEditor() {
  const on = $id('m-risk').checked;
  $id('m-risk-box').hidden = !on;
  const pr = +$id('m-prob').value, im = +$id('m-impact').value;
  const v = (pr > 0 && im > 0) ? pr * im : 0;
  const el = $id('m-risk-val');
  el.textContent = v ? v + '（' + (v >= 15 ? '高危，≥15 自动置顶并强制进日报' : v >= 8 ? '中风险' : '低风险') + '）' : '未评分';
  el.className = 'risk-val' + (v >= 15 ? ' bad' : v >= 8 ? ' warn' : '');
}
async function saveTaskModal() {
  const title = $id('m-title').value.trim();
  if (!title) { toast('标题不能为空', 'err'); return; }
  const isNew = !editingTaskId;
  const newPid = (S.mode === 'today' && $id('qProj') && !$id('qProj').hidden && $id('qProj').value) ? +$id('qProj').value : curProject().id;
  const base = isNew
    ? { id: 0, projectId: newPid, createdAt: TODAY, sortOrder: 0, doneAt: '', deferCount: 0, doingSince: '' }
    : getTask(editingTaskId);
  const ns = $id('m-status').value;
  const t = Object.assign({}, base, {
    title: title,
    due: $id('m-due').value || TODAY,
    startDate: $id('m-start').value || '',
    owner: $id('m-owner').value.trim() || '我方',
    pri: $id('m-pri').value,
    status: ns,
    risk: $id('m-risk').checked,
    isMilestone: $id('m-milestone').checked,
    repeat: $id('m-repeat').value,
    note: $id('m-note').value.trim(),
    checklistJson: JSON.stringify(editChecklist),
    riskProb: +$id('m-prob').value || 0,
    riskImpact: +$id('m-impact').value || 0,
    riskMitigate: $id('m-mitigate').value.trim(),
    riskEscalate: $id('m-escalate').value.trim(),
    parentId: +$id('m-parent').value || 0
  });
  if (ns !== base.status) {
    t.doneAt = (ns === 'done') ? TODAY : '';
    if (ns === 'doing' && !t.doingSince) t.doingSince = nowMinStr();
    if (ns === 'done') { t.deferCount = 0; }
    else if (t.doingSince) t.doingSince = '';
  }
  try {
    await persistTask(t);
    closeModal('mw-task');
    render();
    toast(isNew ? '已添加' : '已保存');
  } catch (e) { toastErr('保存失败', e); }
}
function renderChecklistEditor() {
  $id('m-cl-items').innerHTML = editChecklist.map((it, i) =>
    '<div class="cl-item ' + (it.done ? 'done' : '') + '">'
    + '<input type="checkbox" ' + (it.done ? 'checked' : '') + ' onchange="clToggle(' + i + ')">'
    + '<span class="cl-text">' + esc(it.text) + '</span>'
    + '<button class="cl-rm" title="删除" onclick="clRemove(' + i + ')">✕</button></div>').join('');
}
function clToggle(i) { editChecklist[i].done = !editChecklist[i].done; renderChecklistEditor(); }
function clRemove(i) { editChecklist.splice(i, 1); renderChecklistEditor(); }
function clAdd() {
  const v = $id('m-cl-input').value.trim();
  if (!v) return;
  editChecklist.push({ text: v, done: false });
  $id('m-cl-input').value = '';
  renderChecklistEditor();
  $id('m-cl-input').focus();
}
function askDelTask(id) {
  const t = getTask(id); if (!t) return;
  askConfirm('删除事项', '确认删除「' + t.title + '」？删除后进回收站保留 30 天，可随时恢复。', true).then(ok => {
    if (ok) { closeModal('mw-task'); delTaskById(id, true); }
  });
}

/* ============ 项目设置弹窗 ============ */
function openProjectSettings(id) {
  const p = S.projects.find(x => x.id == id); if (!p) return;
  editingProjectId = p.id;
  const s = parseSettings(p);
  $id('p-name').value = p.name;
  $id('p-report').value = s.report || '';
  for (let i = 0; i < 3; i++) {
    $id('p-m' + (i + 1) + 'l').value = (s.milestones[i] && s.milestones[i].label) || '';
    $id('p-m' + (i + 1) + 'd').value = (s.milestones[i] && s.milestones[i].date) || '';
  }
  $id('p-arch').checked = !!p.archived;
  const wh = s.webhook || { type: '', url: '', secret: '' };
  $id('p-wh-type').value = wh.type || '';
  $id('p-wh-url').value = wh.url || '';
  $id('p-wh-secret').value = wh.secret || '';
  $id('p-budget').value = s.budgetHours > 0 ? s.budgetHours : '';
  toggleWhSecret();
  openModal('mw-proj');
}
function toggleWhSecret() {
  $id('p-wh-secret-row').hidden = $id('p-wh-type').value !== 'dingtalk';
}
async function saveProjectModal() {
  const p = S.projects.find(x => x.id == editingProjectId); if (!p) return;
  const nm = $id('p-name').value.trim();
  if (!nm) { toast('项目名称不能为空', 'err'); return; }
  p.name = nm;
  const s = parseSettings(p);
  s.report = $id('p-report').value.trim() || (nm + ' 进度日报');
  s.milestones = [];
  for (let i = 0; i < 3; i++) {
    s.milestones.push({ label: $id('p-m' + (i + 1) + 'l').value.trim(), date: $id('p-m' + (i + 1) + 'd').value });
  }
  s.webhook = { type: $id('p-wh-type').value, url: $id('p-wh-url').value.trim(), secret: $id('p-wh-secret').value.trim() };
  s.budgetHours = Math.max(0, +$id('p-budget').value || 0);
  p.settingsJson = JSON.stringify(s);
  p.archived = $id('p-arch').checked;
  try {
    await persistProject(p);
    if (p.archived && p.id == S.cur) {
      const alive = S.projects.filter(x => !x.archived);
      if (alive.length) await switchProject(alive[0].id);
    }
    closeModal('mw-proj');
    render();
    toast('项目设置已保存');
  } catch (e) { toastErr('保存项目失败', e); }
}
/* 项目模板（#4）：把现有项目另存为模板（任务集骨架） */
async function saveProjectAsTemplate() {
  const p = S.projects.find(x => x.id == editingProjectId); if (!p) return;
  const name = await askPrompt('另存为项目模板', '模板名称：', p.name + '模板');
  if (!name || !name.trim()) return;
  const tplTasks = projTasks(p.id).filter(t => t.status !== 'done').map(t => ({
    title: t.title, note: t.note, pri: t.pri, owner: t.owner, repeat: t.repeat || '', checklistJson: t.checklistJson || '[]'
  }));
  const tpls = await getJsonMeta('templates', []);
  tpls.push({ id: Date.now(), name: name.trim(), tasks: tplTasks });
  await putJsonMeta('templates', tpls);
  toast('已保存模板「' + name.trim() + '」（' + tplTasks.length + ' 条任务骨架），新建项目时可选用');
}
async function deleteProjectFlow() {
  const p = S.projects.find(x => x.id == editingProjectId); if (!p) return;
  const n = projTasks(p.id).length;
  const ok = await askConfirm('删除项目', '确认删除项目「' + p.name + '」及其全部 ' + n + ' 条事项？<br><b>项目将进入回收站，30 天内可恢复。</b><br><br>也可先在左下角点「备份」导出 JSON。', true);
  if (!ok) return;
  try {
    await invoke('delete_project', { id: p.id });
    S.projects = S.projects.filter(x => x.id != p.id);
    S.tasks = S.tasks.filter(t => t.projectId != p.id);
    /* 计时中的任务随项目删除时，先收掉计时条，避免继续为不存在的任务计时/写工时 */
    if (S.timer && !getTask(S.timer.taskId)) { S.timer = null; updateTimerBar(); }
    S.frogs.ids = S.frogs.ids.filter(fid => getTask(fid));
    refreshTrashCount();
    const alive = S.projects.filter(x => !x.archived);
    if (!alive.length) {
      const np = await createProject('新项目');
      S.cur = '' + np.id;
    } else if (!curProject() || curProject().archived) {
      S.cur = '' + alive[0].id;
    }
    closeModal('mw-proj');
    render();
    toast('项目已删除（回收站可恢复）');
  } catch (e) { toastErr('删除项目失败', e); }
}

/* ============ 报告 ============ */
async function getShutdownMeta(dateStr) {
  return getJsonMeta('shutdown_' + dateStr, null);
}
async function openReport(kind) {
  const p = curProject(); if (!p) return;
  const s = parseSettings(p);
  const ts = projTasks(p.id);
  let out = '';
  if (kind === 'day') {
    const yest = addDays(TODAY, -1);
    const doneL = ts.filter(t => t.status === 'done' && t.doneAt === yest);
    const planL = ts.filter(t => (t.status === 'todo' || t.status === 'doing') && t.due <= TODAY).sort((a, b) => a.due < b.due ? -1 : 1);
    const riskL = ts.filter(t => t.risk && t.status !== 'done')
      .slice().sort((a, b) => riskValue(b) - riskValue(a));
    out = '【' + s.report + '】' + TODAY + '\n\n一、昨日完成：\n';
    const shut = await getShutdownMeta(yest);
    let hadShut = false;
    if (shut && shut.done && shut.done.trim()) { hadShut = true; out += '  ★ ' + shut.done.trim() + '\n'; }
    out += doneL.length ? doneL.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n') : (hadShut ? '' : '  （无，请补录昨天完成的事项）');
    /* 收尾问答的「明天三件事」进入今日计划最前（#2） */
    let planLines = [];
    if (shut && shut.next3 && shut.next3.trim()) {
      shut.next3.trim().split(/\n+/).forEach(l => planLines.push('  ★ ' + l.trim()));
    }
    planL.forEach(t => planLines.push('  ▶ ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t)));
    out += '\n\n二、今日计划：\n' + (planLines.length ? planLines.join('\n') : '  （无）');
    out += '\n\n三、风险与需您决策事项：\n';
    out += riskL.length ? riskL.map(t => {
      const rv = riskValue(t);
      return '  ⚠ ' + t.title + (rv ? '［风险值 ' + rv + '：概率' + t.riskProb + '×影响' + t.riskImpact + '］' : '')
        + ' ｜ 状态：' + (t.status === 'wait' ? '等待' + (t.owner || '对方') + '回复' : '推进中')
        + (t.riskMitigate ? ' ｜ 应对：' + t.riskMitigate : '')
        + (t.riskEscalate ? ' ｜ 升级条件：' + t.riskEscalate : '')
        + (t.note && !t.riskMitigate ? ' ｜ ' + t.note : '');
    }).join('\n') : '  （无）';
    /* 包3 #9：日报自动附最近决策 */
    const recentDec = S.decisions.filter(d => d.projectId == p.id).slice(0, 3);
    out += '\n\n四、最近决策（决策日志）：\n';
    out += recentDec.length ? recentDec.map(d =>
      '  🏛 [' + (d.date || '') + '·' + (d.status || '生效中') + '] ' + d.title + (d.decision ? ' → ' + d.decision : '')).join('\n') : '  （无）';
    try {
      const logs = await invoke('get_time_logs', { since: TODAY }) || [];
      const mine = logs.filter(l => l.date === TODAY && projTasks(p.id).some(t => t.id == l.taskId));
      if (mine.length) {
        const mins = mine.reduce((x, l) => x + (l.minutes || 0), 0);
        out += '\n\n五、今日投入：' + (mins / 60).toFixed(1) + ' 小时（' + mine.length + ' 段计时）';
      }
    } catch (e) {}
    /* 包1 #4：日报附预算燃烧率 */
    if (s.budgetHours > 0) {
      try {
        const logs = await invoke('get_time_logs', { since: addDays(TODAY, -7) }) || [];
        const usedAll = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const burnWk = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const pct = Math.round(usedAll / s.budgetHours * 100);
        out += '\n\n六、工时预算：已用 ' + usedAll.toFixed(1) + ' / ' + s.budgetHours + ' 小时（' + pct + '%），近 7 天燃烧 ' + burnWk.toFixed(1) + ' 小时/周。';
      } catch (e) {}
    }
    if (shut && shut.stuck && shut.stuck.trim()) {
      out += '\n\n附：昨日收尾记录的卡点\n  ⛔ ' + shut.stuck.trim();
    }
    if (shut && shut.block && shut.block.trim()) {
      out += '\n  🛡 阻碍：' + shut.block.trim().replace(/\n/g, '；');
    }
    out += '\n\n—— 在本机点开项目：pm-todo://project/' + p.id;
  } else {
    const wkStart = addDays(TODAY, -6), wkEnd = addDays(TODAY, 7);
    const d1 = ts.filter(t => t.status === 'done' && t.doneAt && t.doneAt >= wkStart && t.doneAt <= TODAY);
    const d2 = ts.filter(t => (t.status === 'todo' || t.status === 'doing') && t.due > TODAY && t.due <= wkEnd);
    const d3 = ts.filter(t => t.status !== 'done' && (t.risk || t.status === 'wait'))
      .slice().sort((a, b) => riskValue(b) - riskValue(a));
    out = '【' + s.report.replace('日报', '周报') + '】' + wkStart + ' ~ ' + TODAY + '\n\n一、本周完成（' + d1.length + ' 项）：\n';
    out += d1.length ? d1.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n') : '  （无）';
    out += '\n\n二、下周计划：\n';
    out += d2.length ? d2.map(t => '  ▶ ' + t.title + '（' + (t.owner || '我方') + '，' + t.due + '）').join('\n') : '  （无）';
    out += '\n\n三、当前风险与阻塞项：\n';
    out += d3.length ? d3.map(t => {
      const rv = riskValue(t);
      return '  ⚠ ' + t.title + (rv ? '［风险值 ' + rv + '］' : '') + (t.riskMitigate ? ' ｜ 应对：' + t.riskMitigate : '') + (t.note && !t.riskMitigate ? ' ｜ ' + t.note : '');
    }).join('\n') : '  （无）';
    try {
      const logs = await invoke('get_time_logs', { since: wkStart }) || [];
      const week = logs.filter(l => l.date >= wkStart && l.date <= TODAY);
      if (week.length) {
        const byProj = {};
        week.forEach(l => { const k = l.projectId || 0; byProj[k] = (byProj[k] || 0) + (l.minutes || 0); });
        out += '\n\n四、本周各项目投入工时：\n';
        Object.keys(byProj).sort((a, b) => byProj[b] - byProj[a]).forEach(k => {
          out += '  📂 ' + (k === '0' ? '收件箱' : projNameOf(+k) || '（已删项目）') + '：' + (byProj[k] / 60).toFixed(1) + ' 小时\n';
        });
      }
    } catch (e) {}
    /* 包3 #9 + 包1 #4：周报附最近决策与预算燃烧率 */
    const recentDec = S.decisions.filter(d => d.projectId == p.id).slice(0, 5);
    if (recentDec.length) {
      out += '\n五、近期决策：\n';
      out += recentDec.map(d => '  🏛 [' + (d.date || '') + '] ' + d.title).join('\n');
    }
    if (s.budgetHours > 0) {
      try {
        const logs = await invoke('get_time_logs', { since: wkStart }) || [];
        const usedAll = await invoke('get_time_logs', { since: '2000-01-01' }).catch(() => []) || [];
        const used = usedAll.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const burnWk = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        out += '\n\n六、工时预算：已用 ' + used.toFixed(1) + ' / ' + s.budgetHours + ' 小时（' + Math.round(used / s.budgetHours * 100) + '%），本周燃烧 ' + burnWk.toFixed(1) + ' 小时。';
      } catch (e) {}
    }
    out += '\n\n—— 在本机点开项目：pm-todo://project/' + p.id;
  }
  $id('r-title').textContent = kind === 'day' ? '日报预览（发送前补全括号内容）' : '周报预览（发送前核对日期范围）';
  $id('r-kind').value = kind;
  $id('r-area').value = out;
  $id('r-wh').hidden = !(s.webhook && s.webhook.type && s.webhook.url);
  $id('r-wh').textContent = '📤 发到群（' + ({ wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' }[s.webhook.type] || s.webhook.type) + '）';
  openModal('mw-report');
}
function clSuffix(t) {
  const cl = checklistSummary(t);
  return cl && cl.total ? '［清单 ' + cl.done + '/' + cl.total + '］' : '';
}
function copyReport() {
  copyText($id('r-area').value, '已复制，去微信/邮件粘贴即可');
}
/* 日报/周报一键发到群机器人（#8）：企微/钉钉/飞书 Webhook */
async function sendReportToGroup() {
  const p = curProject(); if (!p) return;
  const s = parseSettings(p);
  const wh = s.webhook || {};
  if (!wh.type || !wh.url) { toast('先在项目设置里配置群机器人 Webhook', 'err'); return; }
  const text = $id('r-area').value;
  let body;
  if (wh.type === 'feishu') body = { msg_type: 'text', content: { text: text } };
  else body = { msgtype: 'text', text: { content: text } };
  /* 企业微信/钉钉单条上限约 4096 字节，超长分段发送 */
  const chunks = [];
  let rest = text;
  while (rest.length) { chunks.push(rest.slice(0, 1800)); rest = rest.slice(1800); }
  if (!chunks.length) chunks.push('');
  try {
    for (let i = 0; i < chunks.length; i++) {
      const b = wh.type === 'feishu' ? { msg_type: 'text', content: { text: chunks[i] } } : { msgtype: 'text', text: { content: chunks[i] } };
      const resp = await invoke('send_webhook', { url: wh.url, signType: wh.type === 'dingtalk' ? 'dingtalk' : '', secret: wh.secret || '', body: JSON.stringify(b) });
      if (i === 0 && /errcode["']?\s*[:=]\s*[^0]/i.test(resp) && /errmsg/i.test(resp)) {
        throw new Error('机器人返回错误：' + resp);
      }
    }
    toast('已发送到' + ({ wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' }[wh.type]) + '群（' + chunks.length + ' 条消息）');
  } catch (e) { toastErr('发送失败', e); }
}
/* ============ AI 润色（#16）：自定义模型供应商 ============
 * 参考 ZCode 的自定义模型供应商：预设一家供应商（或完全自定义）+ Base URL + API Key + 模型 ID。
 * 统一走 OpenAI 兼容 /chat/completions 协议；本机 Ollama 的 /v1 端点也兼容，无需单独适配。
 * 配置存 meta('aiProvider')，密钥只存本机 SQLite，请求由本地 Rust 进程直连供应商。 */
const AI_PRESETS = [
  { id: 'zhipu',       name: '智谱 GLM（有免费档）',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              model: 'glm-4.6' },
  { id: 'deepseek',    name: 'DeepSeek',                  baseUrl: 'https://api.deepseek.com/v1',                       model: 'deepseek-chat' },
  { id: 'moonshot',    name: '月之暗面 Kimi',              baseUrl: 'https://api.moonshot.cn/v1',                        model: 'kimi-k2-0905-preview' },
  { id: 'dashscope',   name: '阿里云百炼（通义千问）',      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow',       baseUrl: 'https://api.siliconflow.cn/v1',                     model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'openai',      name: 'OpenAI',                    baseUrl: 'https://api.openai.com/v1',                         model: 'gpt-4o-mini' },
  { id: 'openrouter',  name: 'OpenRouter（多模型聚合）',    baseUrl: 'https://openrouter.ai/api/v1',                      model: '' },
  { id: 'ollama',      name: '本机 Ollama（无需 Key）',    baseUrl: 'http://localhost:11434/v1',                         model: 'qwen2.5:3b' },
  { id: 'custom',      name: '自定义（任何 OpenAI 兼容服务）', baseUrl: '', model: '' }
];
const AI_POLISH_SYSTEM = '你是资深项目经理。把用户给出的项目日报/周报草稿润色成适合直接发到工作群的版本：保持事实、数字与事项完全不变，不得虚构或遗漏；结构清晰、语气专业简练；保留原有分段标题与条目顺序。直接输出润色后的全文，不要任何解释、前后缀或代码块标记。';

/* ---- 供应商档案管理：可保存多家（各存各的 Key），点卡片一键切换启用 ---- */
async function loadAiProfiles() {
  const list = await getJsonMeta('aiProviders', null);
  if (Array.isArray(list)) {
    const ok = list.filter(p => p && typeof p === 'object' && p.baseUrl);
    if (ok.length) {
      return ok.map((p, i) => ({
        id: String(p.id || (p.preset || 'custom') + '-' + i),
        preset: p.preset || 'custom',
        name: p.name || '供应商' + (i + 1),
        baseUrl: String(p.baseUrl || ''),
        apiKey: String(p.apiKey || ''),
        model: String(p.model || '')
      }));
    }
  }
  /* 迁移：单供应商版 meta aiProvider → 档案列表 */
  const single = await getJsonMeta('aiProvider', null);
  if (single && typeof single === 'object' && single.baseUrl) {
    return [{
      id: String(single.preset || 'custom'), preset: single.preset || 'custom',
      name: single.name || '自定义', baseUrl: String(single.baseUrl),
      apiKey: String(single.apiKey || ''), model: String(single.model || '')
    }];
  }
  /* 迁移：初版 meta aiModel（Ollama 模型名）→ 本机 Ollama 档案 */
  const legacy = (await invoke('get_meta', { key: 'aiModel' }).catch(() => null)) || '';
  const p0 = AI_PRESETS.find(x => x.id === 'ollama');
  return [{ id: 'ollama', preset: p0.id, name: p0.name, baseUrl: p0.baseUrl, apiKey: '', model: String(legacy).trim() || p0.model }];
}
/* AI 功能入口读取当前启用的供应商（无需打开设置） */
async function loadAiCfg() {
  const profiles = await loadAiProfiles();
  const activeId = await getJsonMeta('aiActiveId', null);
  const p = profiles.find(x => x.id === activeId) || profiles[0];
  return { id: p.id, preset: p.preset, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
}
let aiProfiles = [], aiActiveId = '', aiSelId = '';
function aiFieldsToProfile() {
  const pid = $id('st-ai-preset').value;
  const preset = AI_PRESETS.find(x => x.id === pid) || AI_PRESETS[AI_PRESETS.length - 1];
  return {
    preset: preset.id,
    baseUrl: $id('st-ai-baseurl').value.trim(),
    apiKey: $id('st-ai-key').value.trim(),
    model: $id('st-ai-model').value.trim()
  };
}
/* 切换选中前把表单里未保存的改动暂存回内存档案，避免来回点丢修改。
 * preset 不回写：onchange 触发时下拉已是新值，而预设只是填写模板，另存时才固化进档案。 */
function aiStashFields() {
  const p = aiProfiles.find(x => x.id === aiSelId);
  if (p) Object.assign(p, aiFieldsToProfile(), { preset: p.preset });
}
function aiRenderProfiles() {
  $id('st-ai-profiles').innerHTML = aiProfiles.map(p =>
    '<div class="ai-prof' + (p.id === aiSelId ? ' sel' : '') + '" onclick="aiPickProfile(\'' + p.id + '\')">'
    + '<span class="ai-dot' + (p.id === aiActiveId ? ' on' : '') + '"></span>'
    + '<span class="ai-pn">' + esc(p.name) + (p.id === aiActiveId ? '<i class="ai-cur">当前</i>' : '') + '</span>'
    + '<span class="ai-pm">' + esc(p.model || '未设模型') + '</span></div>'
  ).join('');
}
function aiPickProfile(id) {
  if (id === aiSelId) return;
  aiStashFields();
  aiSelId = id; aiActiveId = id;
  aiRenderProfiles();
  const p = aiProfiles.find(x => x.id === id);
  aiFillSettings(p);
  aiStatus('已切换到「' + p.name + '」，点底部「保存」生效');
}
function aiFillSettings(p) {
  p = p || {};
  $id('st-ai-preset').value = AI_PRESETS.some(x => x.id === p.preset) ? p.preset : 'custom';
  $id('st-ai-baseurl').value = p.baseUrl || '';
  $id('st-ai-key').value = p.apiKey || '';
  $id('st-ai-model').value = p.model || '';
  $id('st-ai-key').placeholder = $id('st-ai-preset').value === 'ollama' ? '本机 Ollama 无需 Key' : 'sk-…';
}
function aiPresetChanged() {
  const p = AI_PRESETS.find(x => x.id === $id('st-ai-preset').value);
  if (!p) return;
  /* 换预设 = 开始填一份新草稿：先把当前档案已填的内容暂存回去，避免被预设默认值覆盖 */
  aiStashFields();
  if (p.baseUrl) $id('st-ai-baseurl').value = p.baseUrl;
  if (p.model) $id('st-ai-model').value = p.model;
  $id('st-ai-key').placeholder = p.id === 'ollama' ? '本机 Ollama 无需 Key' : 'sk-…';
  aiRenderChips([]);
  aiStatus('');
}
function aiStatus(msg, isErr) {
  const el = $id('st-ai-status');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('ai-status-err', !!isErr);
}
/* 拉取到的模型以可点选 chip 呈现（比 datalist 少一次空输入+双击） */
function aiRenderChips(list) {
  const box = $id('st-ai-chips');
  list = (list || []).slice(0, 20);
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = list.map(m => '<button type="button" class="ai-chip" data-m="' + esc(m) + '" onclick="aiPickModel(this)">' + esc(m) + '</button>').join('');
  box.hidden = false;
}
function aiPickModel(btn) {
  const m = btn.getAttribute('data-m');
  $id('st-ai-model').value = m;
  aiStatus('已选择模型 ' + m);
}
async function aiFetchModels() {
  const cfg = aiFieldsToProfile();
  if (!cfg.baseUrl) { aiStatus('请先填写 API 地址（Base URL）', true); return; }
  const btn = $id('st-ai-models');
  btn.disabled = true; aiStatus('正在拉取模型列表…');
  try {
    const list = await invoke('ai_list_models', { cfg: JSON.stringify(cfg) });
    $id('aiModelList').innerHTML = (list || []).map(m => '<option value="' + esc(m) + '">').join('');
    if (list && list.length) {
      aiRenderChips(list);
      aiStatus('拉取到 ' + list.length + ' 个模型：点击下方模型名即可填入' + (list.length > 20 ? '（仅显示前 20 个）' : ''));
    } else {
      aiRenderChips([]);
      aiStatus('该服务未返回模型列表，直接手动填写模型 ID 即可');
    }
  } catch (e) {
    aiStatus('拉取失败：' + (e && e.message || e) + '（不影响使用，可直接手动填模型 ID）', true);
  } finally { btn.disabled = false; }
}
async function aiTestConn() {
  const cfg = aiFieldsToProfile();
  if (!cfg.baseUrl || !cfg.model) { aiStatus('Base URL 和模型 ID 都填好才能测试', true); return; }
  const btn = $id('st-ai-test');
  btn.disabled = true; aiStatus('正在发送测试消息（首次调用可能较慢）…');
  try {
    const out = await invoke('ai_chat', { cfg: JSON.stringify(cfg), system: '你是连通性测试助手，只回复两个字：正常', user: 'ping' });
    aiStatus('✅ 连接成功，模型回复：' + String(out).slice(0, 60));
  } catch (e) {
    aiStatus('❌ ' + (e && e.message || e), true);
  } finally { btn.disabled = false; }
}
async function aiAddProfile() {
  /* 注意：不回写当前选中档案——表单里是要另存的新供应商草稿 */
  const f = aiFieldsToProfile();
  if (!f.baseUrl || !f.model) { aiStatus('Base URL 和模型 ID 填好后再添加为新供应商', true); return; }
  const preset = AI_PRESETS.find(x => x.id === f.preset) || AI_PRESETS[AI_PRESETS.length - 1];
  let name = preset.name;
  if (aiProfiles.some(p => p.name === name)) name = preset.name + '（' + (aiProfiles.filter(p => p.preset === f.preset).length + 1) + '）';
  const prof = { id: 'p' + Date.now().toString(36), preset: f.preset, name: name, baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.model };
  aiProfiles.push(prof);
  aiSelId = prof.id; aiActiveId = prof.id;
  aiRenderProfiles();
  aiStatus('已添加「' + name + '」并设为当前，点底部「保存」生效');
}
/* 删除用按钮二连击确认：设置弹窗层级高于确认弹窗，不能用 askConfirm */
let aiDelArm = false, aiDelTimer = null;
function aiDelProfile() {
  const btn = $id('st-ai-del');
  if (aiProfiles.length <= 1) { aiStatus('至少保留一个供应商，无法删除', true); return; }
  if (!aiDelArm) {
    aiDelArm = true;
    btn.textContent = '确认删除？';
    btn.classList.add('armed');
    aiDelTimer = setTimeout(() => { aiDelArm = false; btn.textContent = '🗑'; btn.classList.remove('armed'); }, 3000);
    return;
  }
  clearTimeout(aiDelTimer); aiDelArm = false;
  btn.textContent = '🗑'; btn.classList.remove('armed');
  const p = aiProfiles.find(x => x.id === aiSelId);
  aiProfiles = aiProfiles.filter(x => x.id !== aiSelId);
  if (aiActiveId === p.id) aiActiveId = aiProfiles[0].id;
  aiSelId = aiActiveId;
  aiRenderProfiles();
  aiFillSettings(aiProfiles.find(x => x.id === aiSelId));
  aiStatus('已删除「' + p.name + '」，点底部「保存」生效');
}
/* AI 入口共用守卫：未配置供应商时引导打开设置，返回 null 表示中断 */
async function ensureAiCfg() {
  let cfg = null;
  try { cfg = await loadAiCfg(); } catch (e) { toastErr('读取 AI 配置', e); return null; }
  if (!cfg.baseUrl || !cfg.model) {
    toast('想用 AI：先在设置（⚙）里选择模型供应商并保存', 'err');
    openSettings();
    return null;
  }
  return cfg;
}
/* AI 常把数组包在 ```json 围栏或解释文字里，取第一个 [ 到最后一个 ] 再解析 */
function extractJsonArray(text) {
  const t = String(text || '');
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s < 0 || e <= s) throw new Error('AI 没有返回任务列表 JSON');
  let arr;
  try { arr = JSON.parse(t.slice(s, e + 1)); } catch (err) { throw new Error('AI 返回格式无法解析，请重试一次'); }
  if (!Array.isArray(arr)) throw new Error('AI 没有返回任务列表');
  return arr;
}
/* 润色报告：走设置里配置的供应商；结果可一键撤销（AI 措辞未必比原文好） */
async function aiPolishReport() {
  const btn = $id('r-ai');
  const orig = btn.textContent;
  const cfg = await ensureAiCfg(); if (!cfg) return;
  const before = $id('r-area').value;
  btn.textContent = '⏳ 润色中…'; btn.disabled = true;
  try {
    const out = await invoke('ai_chat', { cfg: JSON.stringify(cfg), system: AI_POLISH_SYSTEM, user: before });
    if (out === before) { toast('AI 看过了：已足够好，未做改动', 'info'); return; }
    $id('r-area').value = out;
    toast('✨ AI 润色完成（' + (cfg.name || cfg.preset) + ' · ' + cfg.model + '）', 'ok',
      { label: '撤销', onClick: () => { $id('r-area').value = before; } });
  } catch (e) {
    toastErr('AI 润色失败', e);
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

/* ============ AI 粘贴转任务（#16 增强） ============
 * PM 最耗时的整理工作：把会议记录 / 群聊 / 邮件里的待办搬进系统。
 * AI 只产出「草稿」，先预览可改，勾选确认后才写数据。 */
const AI_PARSE_SYSTEM = '你是项目管理助手，从用户给的原始文字（会议记录/群聊/邮件/笔记）中提取所有需要跟进的任务。'
  + '今天是 {today}。只输出严格的 JSON 数组，不要解释、不要代码块，每项形如：'
  + '{"title":"一句话可执行的任务标题","due":"YYYY-MM-DD 或空","owner":"人名或空","pri":"P0|P1|P2，不明确给P1","risk":true或false,"note":"一句话补充背景或卡点，可空"}。'
  + '规则：明天/下周五/月底等相对时间按 {today} 换算成具体日期，无法判断就留空；owner 只取原文明确提到的人名；原文提到卡住/延期/风险/依赖则 risk=true；同一件事只出一条；没有任务就输出 []。';
let atParsed = [];
function atRowHtml(it, i) {
  return '<div class="at-row">'
    + '<input type="checkbox" class="at-ck" checked data-i="' + i + '" title="勾选后才会添加">'
    + '<input type="text" class="at-title" value="' + esc(it.title) + '">'
    + '<input type="date" class="at-due" value="' + esc(it.due || '') + '" title="截止日期">'
    + '<input type="text" class="at-owner" value="' + esc(it.owner || '') + '" placeholder="负责人">'
    + '<select class="at-pri">' + ['P0', 'P1', 'P2'].map(p => '<option' + (p === (it.pri || 'P1') ? ' selected' : '') + '>' + p + '</option>').join('') + '</select>'
    + '<label class="at-risk" title="计入日报风险栏"><input type="checkbox" class="at-riskck"' + (it.risk ? ' checked' : '') + '>⚠</label>'
    + '</div>';
}
async function openAiTask() {
  atParsed = [];
  $id('at-input').value = '';
  const res = $id('at-results');
  res.hidden = true; res.innerHTML = '';
  $id('at-import').hidden = true;
  $id('at-status').textContent = '';
  const opts = [{ v: 0, n: '📥 收件箱（稍后分拣）' }].concat(
    S.projects.filter(p => !p.archived).map(p => ({ v: p.id, n: p.name }))
  );
  $id('at-proj').innerHTML = opts.map(o => '<option value="' + o.v + '">' + esc(o.n) + '</option>').join('');
  /* 默认目标：收件箱模式 → 收件箱；否则当前项目 */
  const cur = curProject();
  const defPid = S.qInbox ? 0 : (cur ? cur.id : 0);
  $id('at-proj').value = opts.some(o => String(o.v) === String(defPid)) ? String(defPid) : '0';
  openModal('mw-aitask');
  setTimeout(() => $id('at-input').focus(), 20);
}
async function aiParseTasks() {
  const text = $id('at-input').value.trim();
  if (!text) { $id('at-status').textContent = '先粘贴原始文字（会议记录 / 群聊 / 邮件都行）'; return; }
  const cfg = await ensureAiCfg(); if (!cfg) return;
  const btn = $id('at-parse');
  btn.disabled = true; btn.textContent = '⏳ 解析中…';
  $id('at-status').textContent = 'AI 正在拆解任务（一般 3-10 秒）…';
  try {
    const out = await invoke('ai_chat', {
      cfg: JSON.stringify(cfg),
      system: AI_PARSE_SYSTEM.split('{today}').join(TODAY),
      user: text
    });
    atParsed = extractJsonArray(out)
      .map(x => x && typeof x === 'object' ? x : { title: x })
      .map(x => ({
        title: String(x.title || '').trim(),
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(x.due || '')) ? String(x.due) : '',
        owner: String(x.owner || '').trim().slice(0, 20),
        pri: ['P0', 'P1', 'P2'].indexOf(x.pri) >= 0 ? x.pri : 'P1',
        risk: !!x.risk,
        note: String(x.note || '').trim().slice(0, 500)
      }))
      .filter(x => x.title);
    if (!atParsed.length) {
      $id('at-status').textContent = 'AI 没从这段文字里识别出任务：若原文确实没有待办就算了，否则换个说法重试';
      return;
    }
    $id('at-results').innerHTML = atParsed.map(atRowHtml).join('');
    $id('at-results').hidden = false;
    $id('at-import').hidden = false;
    $id('at-import').textContent = '✅ 添加所选（' + atParsed.length + '）';
    $id('at-status').textContent = '解析出 ' + atParsed.length + ' 条草稿，可直接修改后勾选添加';
  } catch (e) {
    $id('at-status').textContent = '解析失败：' + (e && e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = '🔍 AI 解析';
  }
}
async function aiImportParsed() {
  const rows = Array.from($id('at-results').querySelectorAll('.at-row'));
  const pid = +$id('at-proj').value || 0;
  const picked = [];
  rows.forEach((row, i) => {
    if (!row.querySelector('.at-ck').checked) return;
    const src = atParsed[i] || {};
    picked.push({
      id: 0, projectId: pid,
      title: row.querySelector('.at-title').value.trim(),
      due: row.querySelector('.at-due').value,
      owner: row.querySelector('.at-owner').value.trim() || '我方',
      pri: row.querySelector('.at-pri').value,
      status: 'todo', doneAt: '',
      risk: row.querySelector('.at-riskck').checked,
      repeat: '', note: src.note || '',
      createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
    });
  });
  if (!picked.length) { $id('at-status').textContent = '至少勾选一条要添加的任务'; return; }
  try {
    for (const t of picked) await persistTask(t);
    closeModal('mw-aitask');
    const where = pid === 0 ? '📥 收件箱' : '「' + projNameOf(pid) + '」';
    toast('🤖 AI 已添加 ' + picked.length + ' 条任务到' + where + (pid === 0 ? '，记得去收件箱分拣' : ''));
    render();
  } catch (e) { toastErr('添加失败', e); }
}

/* AI 生成检查清单：任务拆解草稿（进编辑器，可改可删后才随任务保存） */
async function aiGenChecklist() {
  const title = $id('m-title').value.trim();
  if (!title) { toast('先填写任务标题，AI 才能生成清单', 'err'); return; }
  const cfg = await ensureAiCfg(); if (!cfg) return;
  const btn = $id('m-cl-ai');
  btn.disabled = true; btn.textContent = '⏳…';
  try {
    const note = $id('m-note').value.trim();
    const out = await invoke('ai_chat', {
      cfg: JSON.stringify(cfg),
      system: '你是资深项目经理。为任务生成检查清单：3-6 条，每条一句话、可验证、按执行顺序，覆盖关键风险点与验收标准。只输出 JSON 数组如 ["条目1","条目2"]，不要解释、不要代码块。',
      user: '任务标题：' + title + (note ? '\n任务备注：' + note : '')
    });
    const items = extractJsonArray(out)
      .map(x => String(x && typeof x === 'object' ? (x.text || x.title || '') : x).trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!items.length) { toast('AI 没有生成清单项，请重试', 'err'); return; }
    let added = 0;
    items.forEach(s => {
      if (!editChecklist.some(c => c.text === s)) { editChecklist.push({ text: s, done: false }); added++; }
    });
    renderChecklistEditor();
    toast(added ? '🤖 已生成 ' + added + ' 条清单草稿，可修改或删除后再保存' : '清单里已有这些条目，未重复添加', added ? 'ok' : 'info');
  } catch (e) { toastErr('AI 生成清单', e); }
  finally { btn.disabled = false; btn.textContent = '🤖'; }
}

/* ============ 备份 / 导入 / CSV ============ */
async function exportBackup() {
  let path = null;
  try {
    path = await TDialog().save({
      title: '导出备份',
      defaultPath: 'pm-backup-' + TODAY + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
  } catch (e) { toastErr('打开保存对话框失败', e); return; }
  if (!path) { toast('桌面版支持选择位置导出；浏览器预览模式不可用', 'info'); return; }
  let timeLogs = [];
  try { timeLogs = await invoke('get_time_logs', { since: '2000-01-01' }) || []; } catch (e) {}
  const data = { v: 4, exportedAt: TODAY, projects: S.projects, tasks: S.tasks, ideas: S.ideas, timeLogs: timeLogs,
    decisions: S.decisions, meetings: S.meetings, contacts: S.contacts };
  try {
    await invoke('save_text_file', { path: path, content: JSON.stringify(data, null, 1) });
    toast('已备份到：' + path);
  } catch (e) { toastErr('备份失败', e); }
}

async function importBackup() {
  let path = null;
  try {
    path = await TDialog().open({
      title: '导入备份',
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
  } catch (e) { toastErr('打开文件对话框失败', e); return; }
  if (!path) { toast('未选择文件；浏览器预览模式不支持导入', 'info'); return; }
  let d = null;
  try {
    const raw = await invoke('read_text_file', { path: path });
    d = JSON.parse(raw);
  } catch (e) { toastErr('文件解析失败', e); return; }
  if (!d || !Array.isArray(d.projects)) { toast('文件格式不对：缺少 projects', 'err'); return; }
  const ok = await askConfirm('导入备份', '导入将<b>覆盖当前全部数据</b>（' + d.projects.length + ' 个项目 / ' + (d.tasks || []).length + ' 条事项），继续？', true);
  if (!ok) return;
  d.projects = d.projects.map(p => ({
    id: +p.id, name: String(p.name || '未命名'), archived: !!p.archived,
    createdAt: p.createdAt || TODAY,
    settingsJson: typeof p.settingsJson === 'string'
      ? p.settingsJson
      : JSON.stringify(p.settings || { report: (p.name || '') + ' 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] })
  }));
  d.tasks = (d.tasks || []).map(t => ({
    id: +t.id, projectId: +t.projectId, title: String(t.title || ''), due: t.due || TODAY,
    owner: t.owner || '', pri: t.pri || 'P1', status: t.status || 'todo', doneAt: t.doneAt || '',
    risk: !!t.risk, repeat: t.repeat || '', note: t.note || '', createdAt: t.createdAt || TODAY, sortOrder: +t.sortOrder || 0,
    updatedAt: t.updatedAt || '',
    checklistJson: typeof t.checklistJson === 'string' ? t.checklistJson : '[]',
    deferCount: +t.deferCount || 0, riskProb: +t.riskProb || 0, riskImpact: +t.riskImpact || 0,
    riskMitigate: t.riskMitigate || '', riskEscalate: t.riskEscalate || '',
    doingSince: t.doingSince || '', parentId: +t.parentId || 0,
    startDate: t.startDate || '', isMilestone: !!t.isMilestone
  }));
  d.ideas = (d.ideas || []).map(i => ({
    id: +i.id, title: String(i.title || ''), note: String(i.note || ''),
    value: Math.max(1, Math.min(10, +i.value || 3)), effort: Math.max(1, Math.min(10, +i.effort || 3)),
    converted: +i.converted || 0, createdAt: i.createdAt || TODAY
  }));
  d.timeLogs = (d.timeLogs || []).map(l => ({
    id: +l.id, taskId: +l.taskId || 0, projectId: +l.projectId || 0,
    date: l.date || TODAY, minutes: +l.minutes || 0, note: l.note || ''
  }));
  /* 决策/会议/干系人必须一起导入：后端 import_data 是全量替换语义，
   * 不传这三类会先 DELETE 再插空数组，等于清空 */
  d.decisions = (d.decisions || []).map(x => ({
    id: +x.id, projectId: +x.projectId || 0, title: String(x.title || ''),
    background: String(x.background || ''), options: String(x.options || ''),
    decision: String(x.decision || ''), reason: String(x.reason || ''),
    date: x.date || TODAY, status: x.status || '生效中',
    taskId: +x.taskId || 0, meetingId: +x.meetingId || 0, createdAt: x.createdAt || ''
  }));
  d.meetings = (d.meetings || []).map(x => ({
    id: +x.id, date: x.date || TODAY, title: String(x.title || ''),
    attendees: String(x.attendees || ''), conclusion: String(x.conclusion || ''),
    projectId: +x.projectId || 0,
    itemsJson: typeof x.itemsJson === 'string' ? x.itemsJson : '[]',
    createdAt: x.createdAt || ''
  }));
  d.contacts = (d.contacts || []).map(x => ({
    id: +x.id, name: String(x.name || ''), org: String(x.org || ''),
    tags: String(x.tags || ''), projects: String(x.projects || ''), note: String(x.note || ''),
    lastContact: x.lastContact || '', followupDays: Math.max(1, +x.followupDays || 7), createdAt: x.createdAt || ''
  }));
  try {
    await invoke('import_data', { data: { projects: d.projects, tasks: d.tasks, ideas: d.ideas, timeLogs: d.timeLogs,
      decisions: d.decisions, meetings: d.meetings, contacts: d.contacts } });
    S.projects = d.projects; S.tasks = d.tasks; S.ideas = d.ideas;
    S.decisions = d.decisions; S.meetings = d.meetings; S.contacts = d.contacts;
    if (!S.projects.length) await createProject('示例项目');
    if (!curProject()) S.cur = '' + S.projects[0].id;
    render();
    toast('导入完成');
  } catch (e) { toastErr('导入失败', e); }
}

async function exportCsv() {
  const p = curProject(); if (!p) return;
  let path = null;
  try {
    path = await TDialog().save({
      title: '导出 CSV',
      defaultPath: p.name + '-任务-' + TODAY + '.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
  } catch (e) { toastErr('打开保存对话框失败', e); return; }
  if (!path) { toast('桌面版支持选择位置导出；浏览器预览模式不可用', 'info'); return; }
  const stMap = { todo: '待办', doing: '进行中', wait: '等人/等外部', done: '已完成' };
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['标题', '截止日期', '负责人', '优先级', '状态', '风险', '循环', '检查清单', '备注', '完成日期', '创建日期', '更新时间']];
  projTasks(p.id).slice().sort(cmpTask).forEach(t => {
    const cl = checklistSummary(t);
    rows.push([t.title, t.due, t.owner || '我方', t.pri || 'P1', stMap[t.status] || t.status,
      t.risk ? '是' : '', repeatLabel(t.repeat),
      cl ? cl.done + '/' + cl.total : '', t.note, t.doneAt, t.createdAt, t.updatedAt || '']);
  });
  const csv = '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n');
  try {
    await invoke('save_text_file', { path: path, content: csv });
    toast('已导出 CSV：' + path);
  } catch (e) { toastErr('导出失败', e); }
}

/* ============ 弹窗基础 / 确认 / 输入 ============ */
function openModal(id) { $id(id).hidden = false; }
function closeModal(id) { $id(id).hidden = true; }

let _confirmResolve = null, _promptResolve = null;
function askConfirm(title, msgHtml, danger) {
  return new Promise(res => {
    _confirmResolve = res;
    $id('c-title').textContent = title;
    $id('c-msg').innerHTML = msgHtml;
    $id('c-ok').className = danger ? 'btn danger' : 'btn blue';
    openModal('mw-confirm');
  });
}
function answerConfirm(v) { closeModal('mw-confirm'); if (_confirmResolve) { _confirmResolve(v); _confirmResolve = null; } }

function askPrompt(title, label, def) {
  return new Promise(res => {
    _promptResolve = res;
    $id('pr-title').textContent = title;
    $id('pr-label').textContent = label;
    $id('pr-input').value = def || '';
    openModal('mw-prompt');
    setTimeout(() => { $id('pr-input').focus(); $id('pr-input').select(); }, 30);
  });
}
function answerPrompt(v) { closeModal('mw-prompt'); if (_promptResolve) { _promptResolve(v); _promptResolve = null; } }

async function openNewProject() {
  const name = await askPrompt('新建项目', '项目名称：', '');
  if (name && name.trim()) {
    const p = await createProject(name.trim());
    S.cur = '' + p.id;
    await invoke('set_meta', { key: 'currentId', value: S.cur }).catch(() => {});
    render();
    toast('项目「' + p.name + '」已创建');
  }
}

/* ============ 新建项目（支持项目模板 #4） ============ */
async function openNewProject() {
  const tpls = await getJsonMeta('templates', []);
  $id('np-name').value = '';
  $id('np-tpl').innerHTML = '<option value="">（空白项目）</option>' + tpls.map(t =>
    '<option value="' + t.id + '">' + esc(t.name) + '（' + (t.tasks || []).length + ' 条骨架）</option>').join('');
  openModal('mw-newproj');
  setTimeout(() => { $id('np-name').focus(); }, 30);
}
async function createProjectFromModal() {
  const name = $id('np-name').value.trim();
  if (!name) { toast('项目名称不能为空', 'err'); return; }
  const tplId = +$id('np-tpl').value || 0;
  const tpls = await getJsonMeta('templates', []);
  const tpl = tpls.find(t => t.id === tplId);
  const p = await persistProject({
    id: 0, name: name, archived: false, createdAt: TODAY,
    settingsJson: JSON.stringify({ report: name + ' 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] })
  });
  let n = 0;
  if (tpl && Array.isArray(tpl.tasks)) {
    for (const tt of tpl.tasks) {
      await persistTask({
        id: 0, projectId: p.id, title: tt.title, due: TODAY, owner: tt.owner || '我方', pri: tt.pri || 'P1',
        status: 'todo', doneAt: '', risk: false, repeat: tt.repeat || '', note: tt.note || '',
        createdAt: TODAY, sortOrder: 0, checklistJson: tt.checklistJson || '[]'
      });
      n++;
    }
  }
  S.cur = '' + p.id;
  await invoke('set_meta', { key: 'currentId', value: S.cur }).catch(() => {});
  closeModal('mw-newproj');
  S.mode = 'project';
  render();
  toast('项目「' + p.name + '」已创建' + (n ? '，已从模板带入 ' + n + ' 条任务（截止日默认今天，可自行调整）' : ''));
}
async function deleteTemplateFromModal() {
  const tplId = +$id('np-tpl').value || 0;
  if (!tplId) { toast('选择要删除的模板', 'info'); return; }
  const tpls = await getJsonMeta('templates', []);
  const tpl = tpls.find(t => t.id === tplId);
  if (!tpl) return;
  const ok = await askConfirm('删除模板', '删除模板「' + tpl.name + '」？不影响已有项目。', true);
  if (!ok) return;
  await putJsonMeta('templates', tpls.filter(t => t.id !== tplId));
  await openNewProject();
  toast('模板已删除');
}

/* ============ 收件箱分拣（#12） ============ */
function renderInbox() {
  const list = S.tasks.filter(t => t.projectId == 0 && t.status === 'todo').sort(cmpTask);
  const alive = S.projects.filter(x => !x.archived);
  if (!list.length) {
    $id('viewInbox').innerHTML = '<div class="empty" style="padding:60px 0;text-align:center;">📥 收件箱已清空。快速添加时点 📥 按钮可先把任务丢进收件箱（Linear Triage 实践）</div>';
    return;
  }
  let h = '<div class="inbox-hint">每天花 2 分钟分拣：给每条任务选项目后点「分派」，无主任务不入项目池。</div>';
  list.forEach(t => {
    h += '<div class="inbox-card">' + cardHtml(t, false)
      + '<div class="assign-row"><span class="assign-lb">分派到：</span>'
      + '<select id="assign-' + t.id + '">' + alive.map(x => '<option value="' + x.id + '">' + esc(x.name) + '</option>').join('') + '</select>'
      + '<button class="btn blue" onclick="assignInbox(' + t.id + ')">分派 →</button>'
      + '<button class="btn ghost" onclick="snoozeTask(' + t.id + ')">⏭ 明天再说</button>'
      + '<button class="btn danger ghost" onclick="delTaskById(' + t.id + ', true)">删除</button>'
      + '</div></div>';
  });
  $id('viewInbox').innerHTML = h;
}
async function assignInbox(id) {
  const sel = $id('assign-' + id);
  if (!sel || !sel.value) return;
  const t = getTask(id); if (!t) return;
  t.projectId = +sel.value;
  try {
    await persistTask(t);
    toast('已分派到「' + projNameOf(t.projectId) + '」');
    render();
  } catch (e) { toastErr('分派失败', e); }
}

/* ============ 智能视图（#9） ============ */
function renderSmart() {
  const v = smartViewById(S.smartId);
  const isAutoStale = S.smartId === 'auto-stale';
  const box = $id('viewSmart');
  if (!v && !isAutoStale) { box.innerHTML = '<div class="empty">视图不存在</div>'; return; }
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  const crit = isAutoStale ? { staleDays: 14 } : v.crit;

  /* 风险登记册：表格化，按风险值排序（#6） */
  if (v && v.register) {
    const rows = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && matchSmart(t, crit))
      .sort((a, b) => riskValue(b) - riskValue(a) || (a.due < b.due ? -1 : 1));
    let h = '<div class="riskreg">';
    h += '<div class="riskreg-head">风险登记册 · 按 概率(1-5)×影响(1-5) 排序，风险值 ≥ ' + RISK_RED + ' 标红置顶并强制进日报风险栏</div>';
    h += '<table><thead><tr><th>项目</th><th>风险</th><th>概率×影响</th><th>风险值</th><th>应对措施</th><th>升级条件</th><th>负责人</th><th>截止</th></tr></thead><tbody>';
    h += rows.length ? rows.map(t => {
      const rv = riskValue(t);
      return '<tr class="' + (rv >= RISK_RED ? 'bad' : rv >= 8 ? 'warn' : '') + '" onclick="openTaskEdit(' + t.id + ')">'
        + '<td>' + esc(projNameOf(t.projectId)) + '</td>'
        + '<td class="rt">' + esc(t.title) + '</td>'
        + '<td>' + (rv ? t.riskProb + ' × ' + t.riskImpact : '<span class="dim">未评分</span>') + '</td>'
        + '<td><b>' + (rv || '—') + '</b></td>'
        + '<td>' + esc(t.riskMitigate || '—') + '</td>'
        + '<td>' + esc(t.riskEscalate || '—') + '</td>'
        + '<td>' + esc(t.owner || '我方') + '</td>'
        + '<td>' + esc(t.due) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">暂无风险任务。给任务勾选「⚠ 计入日报风险栏」并在编辑里评分</td></tr>';
    h += '</tbody></table></div>';
    box.innerHTML = h;
    return;
  }

  const groups = [];
  S.projects.filter(p => !p.archived).forEach(p => {
    let ts2 = S.tasks.filter(t => t.projectId == p.id && matchSmart(t, crit));
    if (ts2.length) groups.push({ p: p, ts: ts2.sort(cmpTask) });
  });
  let h = groups.length ? '' : '<div class="empty" style="padding:60px 0;text-align:center;">没有匹配的任务 🎉</div>';
  groups.forEach(g => {
    h += '<h2 class="grp">📂 ' + esc(g.p.name) + ' <span class="gcnt">' + g.ts.length + ' 项</span>'
      + '<button class="linkbtn" onclick="switchProject(' + g.p.id + ')">进入项目 →</button></h2>';
    g.ts.forEach(t => { h += cardHtml(t, false); });
  });
  box.innerHTML = h;
}
function openSaveSmartView() {
  $id('sv-name').value = '';
  $id('sv-risk').checked = false; $id('sv-overdue').checked = false;
  $id('sv-wait').value = ''; $id('sv-stale').value = ''; $id('sv-pri').value = '';
  openModal('mw-smart');
}
async function saveSmartViewModal() {
  const name = $id('sv-name').value.trim();
  if (!name) { toast('给视图起个名字', 'err'); return; }
  const crit = {};
  if ($id('sv-risk').checked) crit.risk = 1;
  if ($id('sv-overdue').checked) crit.overdue = 1;
  if (+$id('sv-wait').value > 0) crit.waitDays = +$id('sv-wait').value;
  if (+$id('sv-stale').value > 0) crit.staleDays = +$id('sv-stale').value;
  if ($id('sv-pri').value) crit.pri = $id('sv-pri').value;
  if (!Object.keys(crit).length) { toast('至少选一个条件', 'err'); return; }
  S.smartViews.push({ id: 'v' + Date.now(), name: name, crit: crit, builtin: 0 });
  await putJsonMeta('smartViews', S.smartViews);
  closeModal('mw-smart');
  render();
  toast('智能视图「' + name + '」已保存');
}
async function deleteSmartView(id) {
  const v = smartViewById(id); if (!v) return;
  const ok = await askConfirm('删除智能视图', '删除「' + v.name + '」？只删视图，不动任务。', false);
  if (!ok) return;
  S.smartViews = S.smartViews.filter(x => x.id !== id);
  await putJsonMeta('smartViews', S.smartViews);
  S.mode = 'project';
  render();
}

/* ============ 需求池（#14，RICE 简化为 价值/工时） ============ */
let editingIdeaId = 0;
function ideaScore(i2) { return Math.round((i2.value / i2.effort) * 100) / 100; }
function renderIdeas() {
  const box = $id('viewIdeas');
  const list = S.ideas.slice().sort((a, b) => (a.converted - b.converted) || (ideaScore(b) - ideaScore(a)));
  const quad = (i2) => {
    const hiV = i2.value >= 5, loE = i2.effort <= 5;
    return hiV && loE ? 0 : hiV && !loE ? 1 : !hiV && loE ? 2 : 3;
  };
  const quadNames = ['🚀 立即做（高价值 · 低工时）', '🗺 规划做（高价值 · 高工时）', '⚡ 顺手做（低价值 · 低工时）', '🗑 考虑放弃（低价值 · 高工时）'];
  let h = '<div class="idea-add"><input type="text" id="idea-title" placeholder="记一条想法/需求（领导口头诉求、用户反馈…）" onkeydown="if(event.key===\'Enter\')saveIdea()">'
    + '<label>价值</label><select id="idea-v">' + [1,2,3,4,5,6,7,8,9,10].map(v => '<option' + (v === 5 ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>'
    + '<label>工时</label><select id="idea-e">' + [1,2,3,4,5,6,7,8,9,10].map(v => '<option' + (v === 5 ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>'
    + '<button class="btn blue" onclick="saveIdea()">' + (editingIdeaId ? '保存修改' : '＋ 记一条') + '</button>'
    + (editingIdeaId ? '<button class="btn ghost" onclick="cancelIdeaEdit()">取消</button>' : '')
    + '<span class="idea-score-hint">优先分 = 价值 ÷ 工时（airfocus RICE 简化版）</span></div>';
  h += '<div class="idea-quads">';
  quadNames.forEach((qn, qi) => {
    h += '<div class="idea-quad q' + qi + '"><div class="iq-h">' + qn + '</div>';
    const items = list.filter(i2 => !i2.converted && quad(i2) === qi);
    h += items.length ? items.map(i2 =>
      '<div class="idea-row" title="' + esc(i2.note) + '">'
      + '<span class="it">' + esc(i2.title) + '</span>'
      + '<span class="isc">价值' + i2.value + ' ÷ 工时' + i2.effort + ' = <b>' + ideaScore(i2).toFixed(2) + '</b></span>'
      + '<button class="btn ghost" title="编辑" onclick="editIdea(' + i2.id + ')">✎</button>'
      + '<button class="btn teal" title="转为任务" onclick="openConvertIdea(' + i2.id + ')">转任务</button>'
      + '<button class="btn danger ghost" title="删除" onclick="deleteIdea(' + i2.id + ')">✕</button>'
      + '</div>').join('') : '<div class="empty">—</div>';
    h += '</div>';
  });
  h += '</div>';
  const conv = list.filter(i2 => i2.converted);
  if (conv.length) {
    h += '<div class="stat-panel"><h3>已转为任务（' + conv.length + '）</h3>' + conv.map(i2 =>
      '<div class="idea-row done"><span class="it">✔ ' + esc(i2.title) + '</span><span class="isc">价值' + i2.value + ' · 工时' + i2.effort + '</span>'
      + '<button class="btn danger ghost" onclick="deleteIdea(' + i2.id + ')">✕</button></div>').join('') + '</div>';
  }
  box.innerHTML = h;
}
async function saveIdea() {
  const title = $id('idea-title').value.trim();
  if (!title) { toast('先写内容', 'err'); return; }
  const it = editingIdeaId
    ? Object.assign({}, S.ideas.find(x => x.id === editingIdeaId), { title: title, value: +$id('idea-v').value, effort: +$id('idea-e').value })
    : { id: 0, title: title, note: '', value: +$id('idea-v').value, effort: +$id('idea-e').value, converted: 0, createdAt: TODAY };
  try {
    const saved = await invoke('upsert_idea', { idea: it });
    const i2 = S.ideas.findIndex(x => x.id === saved.id);
    if (i2 >= 0) S.ideas[i2] = saved; else S.ideas.push(saved);
    editingIdeaId = 0;
    render();
  } catch (e) { toastErr('保存失败', e); }
}
function editIdea(id) {
  const i2 = S.ideas.find(x => x.id === id); if (!i2) return;
  editingIdeaId = id;
  render();
  $id('idea-title').value = i2.title;
  $id('idea-v').value = i2.value;
  $id('idea-e').value = i2.effort;
  $id('idea-title').focus();
}
function cancelIdeaEdit() { editingIdeaId = 0; render(); }
async function deleteIdea(id) {
  try {
    await invoke('delete_idea', { id: id });
    S.ideas = S.ideas.filter(x => x.id !== id);
    if (editingIdeaId === id) editingIdeaId = 0;
    render();
  } catch (e) { toastErr('删除失败', e); }
}
function openConvertIdea(id) {
  const alive = S.projects.filter(x => !x.archived);
  if (!alive.length) { toast('先创建一个项目', 'err'); return; }
  $id('cv-idea-id').value = id;
  $id('cv-proj').innerHTML = alive.map(x => '<option value="' + x.id + '">' + esc(x.name) + '</option>').join('');
  $id('cv-due').value = TODAY;
  openModal('mw-convert');
}
async function convertIdeaNow() {
  const i2 = S.ideas.find(x => x.id === +$id('cv-idea-id').value); if (!i2) return;
  try {
    await persistTask({
      id: 0, projectId: +$id('cv-proj').value, title: i2.title, due: $id('cv-due').value || TODAY,
      owner: '我方', pri: 'P1', status: 'todo', doneAt: '', risk: false, repeat: '',
      note: '来自需求池：' + (i2.note || '') + '（价值' + i2.value + '/工时' + i2.effort + '）',
      createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
    });
    i2.converted = 1;
    const saved = await invoke('upsert_idea', { idea: i2 });
    const idx = S.ideas.findIndex(x => x.id === saved.id);
    if (idx >= 0) S.ideas[idx] = saved;
    closeModal('mw-convert');
    render();
    toast('需求已转为任务，需求池里标记完成');
  } catch (e) { toastErr('转换失败', e); }
}

/* ============ 包3 #9：项目决策日志（ADR 模板） ============ */
function renderDecisions() {
  const p = curProject(); if (!p) return;
  const list = S.decisions.filter(d => d.projectId == p.id);
  const active = list.filter(d => d.status === '生效中');
  const gone = list.filter(d => d.status !== '生效中');
  let h = '<div class="dec-head"><span class="chip2 cd">🏛 决策日志 · ' + active.length + ' 条生效中</span>'
    + '<span class="chip2">治「口头答应了没人记得」：背景 / 选项 / 决定 / 原因</span>'
    + '<button class="btn blue" style="margin-left:auto;" onclick="openDecisionModal(0)">＋ 记录决策</button></div>';
  const row = d => {
    const links = backlinksOf(d.title).length;
    return '<div class="dec-card' + (d.status !== '生效中' ? ' off' : '') + '" onclick="openDecisionModal(' + d.id + ')">'
      + '<div class="dec-top"><b class="dec-t">' + esc(d.title) + '</b>'
      + '<span class="chip ' + (d.status === '生效中' ? 'clprog' : '') + '">' + esc(d.status || '生效中') + '</span>'
      + '<span class="chip">' + esc(d.date || '') + '</span>'
      + (d.meetingId ? '<span class="chip" title="来自会议">🗂 会议产出</span>' : '')
      + (links ? '<span class="chip">🔗 ' + links + '</span>' : '')
      + '</div>'
      + (d.decision ? '<div class="dec-line">👉 ' + esc(d.decision) + '</div>' : '')
      + (d.reason ? '<div class="dec-why">为什么：' + esc(d.reason) + '</div>' : '')
      + (d.background ? '<div class="dec-sub">背景：' + esc(d.background) + '</div>' : '')
      + (d.options ? '<div class="dec-sub">备选：' + esc(d.options) + '</div>' : '')
      + '</div>';
  };
  h += active.map(row).join('') || '<div class="empty">还没有决策记录。遇到「二选一定了方向」的时刻就记一条。</div>';
  if (gone.length) h += '<h2 class="grp">已废弃 / 被替代 <span class="gcnt">' + gone.length + '</span></h2>' + gone.map(row).join('');
  $id('viewDecisions').innerHTML = h;
}
function openDecisionModal(id) {
  const p = curProject(); if (!p) return;
  const d = id ? S.decisions.find(x => x.id == id) : null;
  $id('d-id').value = d ? d.id : '';
  $id('d-title').value = d ? d.title : '';
  $id('d-date').value = d ? (d.date || TODAY) : TODAY;
  $id('d-background').value = d ? d.background : '';
  $id('d-options').value = d ? d.options : '';
  $id('d-decision').value = d ? d.decision : '';
  $id('d-reason').value = d ? d.reason : '';
  $id('d-status').value = d ? (d.status || '生效中') : '生效中';
  const opts = projTasks(p.id).filter(t => t.status !== 'done');
  $id('d-task').innerHTML = '<option value="0">（无）</option>' + opts.map(t =>
    '<option value="' + t.id + '"' + (d && d.taskId == t.id ? ' selected' : '') + '>' + esc(t.title.slice(0, 30)) + '</option>').join('');
  $id('d-del').hidden = !d;
  openModal('mw-decision');
  setTimeout(() => $id('d-title').focus(), 30);
}
async function saveDecisionModal() {
  const title = $id('d-title').value.trim();
  if (!title) { toast('决策标题不能为空', 'err'); return; }
  const p = curProject(); if (!p) return;
  const orig = +$id('d-id').value ? S.decisions.find(x => x.id == +$id('d-id').value) : null;
  const d = {
    id: +$id('d-id').value || 0, projectId: p.id, title: title,
    background: $id('d-background').value.trim(), options: $id('d-options').value.trim(),
    decision: $id('d-decision').value.trim(), reason: $id('d-reason').value.trim(),
    date: $id('d-date').value || TODAY, status: $id('d-status').value,
    taskId: +$id('d-task').value || 0,
    meetingId: orig ? (orig.meetingId || 0) : 0, /* 编辑时保留原会议溯源，不能写死 0 */
    createdAt: ''
  };
  try {
    const saved = await invoke('upsert_decision', { d: d });
    const i = S.decisions.findIndex(x => x.id == saved.id);
    if (i >= 0) S.decisions[i] = saved; else S.decisions.unshift(saved);
    closeModal('mw-decision');
    render();
    toast('决策已记录：' + title.slice(0, 24));
  } catch (e) { toastErr('保存决策失败', e); }
}
async function deleteDecisionFlow() {
  const id = +$id('d-id').value; if (!id) return;
  const ok = await askConfirm('删除决策', '删除这条决策记录？', true);
  if (!ok) return;
  try {
    await invoke('delete_decision', { id: id });
    S.decisions = S.decisions.filter(x => x.id != id);
    closeModal('mw-decision');
    render();
  } catch (e) { toastErr('删除失败', e); }
}

/* ============ 包3 #10：会议记录 → 行动项（Fellow 模式） ============ */
function parseMeetingItems(json) {
  try {
    const arr = JSON.parse(json || '[]');
    if (Array.isArray(arr)) return arr.filter(x => x && typeof x.text === 'string');
  } catch (e) {}
  return [];
}
function renderMeetings() {
  const box = $id('viewMeetings');
  const list = S.meetings.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  let h = '<div class="dec-head"><span class="chip2 cd">🗂 会议纪要 · ' + list.length + ' 场</span>'
    + '<span class="chip2">会后笔记模板；行动项一键转任务（溯源「来自 X 会议」）</span>'
    + '<button class="btn blue" style="margin-left:auto;" onclick="openMeetingModal(0)">＋ 记一场会议</button></div>';
  if (!list.length) {
    h += '<div class="empty" style="padding:50px 0;text-align:center;">还没有会议记录。开完会把结论和行动项放进来，任务才有人追。</div>';
    box.innerHTML = h;
    return;
  }
  list.forEach(m => {
    const items = parseMeetingItems(m.itemsJson);
    h += '<div class="mt-card" onclick="openMeetingModal(' + m.id + ')">';
    h += '<div class="dec-top"><b class="dec-t">' + esc(m.title || '（无题）') + '</b>'
      + '<span class="chip clprog">📅 ' + esc(m.date || '') + '</span>'
      + (m.projectId ? '<span class="chip projchip">📂 ' + esc(projNameOf(m.projectId)) + '</span>' : '')
      + '<span class="chip">👤 ' + esc(m.attendees || '—') + '</span>'
      + '<span class="chip">' + items.filter(x => x.taskId).length + '/' + items.length + ' 已转任务</span>'
      + '</div>';
    if (m.conclusion) h += '<div class="mdview mt-conc">' + mdRender(m.conclusion) + '</div>';
    if (items.length) {
      h += '<div class="mt-items">';
      items.forEach((it, i) => {
        h += '<div class="mt-item" onclick="event.stopPropagation()">';
        if (it.taskId && getTask(it.taskId)) {
          const t = getTask(it.taskId);
          h += '<span class="bl-item" onclick="jumpBacklink(\'task\',' + it.taskId + ')">✔ ' + esc(it.text) + ' <i>已转任务</i></span>';
        } else if (it.decisionId && S.decisions.some(d => d.id == it.decisionId)) {
          h += '<span class="bl-item" onclick="jumpBacklink(\'decision\',' + it.decisionId + ')">🏛 ' + esc(it.text) + ' <i>已进决策日志</i></span>';
        } else {
          h += '<span class="mt-it-text">▸ ' + esc(it.text) + '</span>'
            + '<button class="btn teal" onclick="meetingItemToTask(' + m.id + ',' + i + ')">转任务</button>'
            + '<button class="btn ghost" onclick="meetingItemToDecision(' + m.id + ',' + i + ')">记为决策</button>';
        }
        h += '</div>';
      });
      h += '</div>';
    }
    h += '</div>';
  });
  box.innerHTML = h;
}
function openMeetingModal(id) {
  const m = id ? S.meetings.find(x => x.id == id) : null;
  $id('mt-id').value = m ? m.id : '';
  $id('mt-title').value = m ? m.title : '';
  $id('mt-date').value = m ? (m.date || TODAY) : TODAY;
  $id('mt-attendees').value = m ? m.attendees : '';
  $id('mt-conclusion').value = m ? m.conclusion : '';
  $id('mt-proj').innerHTML = '<option value="0">（不关联）</option>' + S.projects.filter(p => !p.archived).map(p =>
    '<option value="' + p.id + '"' + (m && m.projectId == p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
  window._mtItems = m ? parseMeetingItems(m.itemsJson).map(x => ({ text: x.text, taskId: x.taskId || 0, decisionId: x.decisionId || 0 })) : [];
  $id('mt-del').hidden = !m;
  renderMeetingItemEditor();
  openModal('mw-meeting');
  setTimeout(() => $id('mt-title').focus(), 30);
}
function renderMeetingItemEditor() {
  $id('mt-items').innerHTML = (window._mtItems || []).map((it, i) =>
    '<div class="cl-item"><span class="cl-text">' + esc(it.text) + '</span>'
    + '<button class="cl-rm" title="删除" onclick="mtItemRemove(' + i + ')">✕</button></div>').join('');
}
function mtItemAdd() {
  const v = $id('mt-item-input').value.trim();
  if (!v) return;
  window._mtItems.push({ text: v, taskId: 0, decisionId: 0 });
  $id('mt-item-input').value = '';
  renderMeetingItemEditor();
  $id('mt-item-input').focus();
}
function mtItemRemove(i) { window._mtItems.splice(i, 1); renderMeetingItemEditor(); }
async function saveMeetingModal() {
  const title = $id('mt-title').value.trim();
  if (!title) { toast('议题不能为空', 'err'); return; }
  const m = {
    id: +$id('mt-id').value || 0, date: $id('mt-date').value || TODAY, title: title,
    attendees: $id('mt-attendees').value.trim(), conclusion: $id('mt-conclusion').value.trim(),
    projectId: +$id('mt-proj').value || 0, itemsJson: JSON.stringify(window._mtItems || []), createdAt: ''
  };
  try {
    const saved = await invoke('upsert_meeting', { m: m });
    const i = S.meetings.findIndex(x => x.id == saved.id);
    if (i >= 0) S.meetings[i] = saved; else S.meetings.unshift(saved);
    closeModal('mw-meeting');
    render();
    toast('会议纪要已保存');
  } catch (e) { toastErr('保存会议失败', e); }
}
async function deleteMeetingFlow() {
  const id = +$id('mt-id').value; if (!id) return;
  const ok = await askConfirm('删除会议纪要', '删除这条会议纪要？已转出的任务/决策不受影响。', true);
  if (!ok) return;
  try {
    await invoke('delete_meeting', { id: id });
    S.meetings = S.meetings.filter(x => x.id != id);
    closeModal('mw-meeting');
    render();
  } catch (e) { toastErr('删除失败', e); }
}
/* 行动项 → 任务：溯源备注「来自 X 会议（日期）」 */
async function meetingItemToTask(meetingId, idx) {
  const m = S.meetings.find(x => x.id == meetingId); if (!m) return;
  const items = parseMeetingItems(m.itemsJson);
  const it = items[idx]; if (!it) return;
  const pid = m.projectId || (curProject() ? curProject().id : 0);
  try {
    const saved = await persistTask({
      id: 0, projectId: pid, title: it.text, due: TODAY, owner: '我方', pri: 'P1',
      status: 'todo', doneAt: '', risk: false, repeat: '',
      note: '来自会议「' + m.title + '」（' + m.date + '）', createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
    });
    it.taskId = saved.id;
    m.itemsJson = JSON.stringify(items);
    const upd = await invoke('upsert_meeting', { m: m });
    const i = S.meetings.findIndex(x => x.id == upd.id);
    if (i >= 0) S.meetings[i] = upd;
    render();
    toast('已转任务：「' + it.text.slice(0, 20) + '」（备注可溯源到会议）');
  } catch (e) { toastErr('转任务失败', e); }
}
/* 行动项 → 决策日志：预填背景=会议结论，日期=会议日期 */
async function meetingItemToDecision(meetingId, idx) {
  const m = S.meetings.find(x => x.id == meetingId); if (!m) return;
  const items = parseMeetingItems(m.itemsJson);
  const it = items[idx]; if (!it) return;
  try {
    const d = {
      id: 0, projectId: m.projectId || 0, title: it.text,
      background: '来自会议「' + m.title + '」（' + m.date + '）' + (m.conclusion ? '\n结论：' + m.conclusion : ''),
      options: '', decision: it.text, reason: '', date: m.date || TODAY,
      status: '生效中', taskId: 0, meetingId: meetingId, createdAt: ''
    };
    const saved = await invoke('upsert_decision', { d: d });
    S.decisions.unshift(saved);
    it.decisionId = saved.id;
    m.itemsJson = JSON.stringify(items);
    const upd = await invoke('upsert_meeting', { m: m });
    const i = S.meetings.findIndex(x => x.id == upd.id);
    if (i >= 0) S.meetings[i] = upd;
    render();
    toast('已记入决策日志：' + it.text.slice(0, 24));
  } catch (e) { toastErr('记为决策失败', e); }
}

/* ============ 包3 #11：干系人跟进（FollowUpThen 机制） ============ */
function contactDueDays(c) {
  /* 距下次跟进还剩几天：负数 = 已逾期 N 天 */
  if (!c.lastContact) return -999;
  return (c.followupDays || 14) - Math.round((new Date(TODAY) - new Date(c.lastContact)) / 86400000);
}
function renderContacts() {
  const box = $id('viewContacts');
  const list = S.contacts.slice().sort((a, b) => contactDueDays(a) - contactDueDays(b));
  let h = '<div class="dec-head"><span class="chip2 cd">👥 干系人 · ' + list.length + ' 人</span>'
    + '<span class="chip2">联系人 + 上次沟通 + 循环周期 → 过期自动生成「跟进某人」进今日聚焦</span>'
    + '<button class="btn blue" style="margin-left:auto;" onclick="openContactModal(0)">＋ 新增干系人</button></div>';
  if (!list.length) {
    h += '<div class="empty" style="padding:50px 0;text-align:center;">还没有干系人档案。把要长期维护关系的人加进来，别靠脑子记「多久没找他了」。</div>';
    box.innerHTML = h;
    return;
  }
  h += '<div class="riskreg"><table><thead><tr><th>姓名</th><th>组织 / 角色</th><th>标签</th><th>关联项目</th><th>上次沟通</th><th>周期</th><th>跟进状态</th><th>操作</th></tr></thead><tbody>';
  list.forEach(c => {
    const due = contactDueDays(c);
    const dueChip = due > 3 ? '<span class="dim">还有 ' + due + ' 天</span>'
      : due >= 0 ? '<span class="chip due-today">今天该跟进</span>'
      : '<span class="chip due-over">逾期 ' + (-due) + ' 天</span>';
    h += '<tr class="' + (due < 0 ? 'bad' : due <= 3 ? 'warn' : '') + '">'
      + '<td class="rt">' + esc(c.name) + '</td>'
      + '<td>' + esc(c.org || '—') + '</td>'
      + '<td>' + esc(c.tags || '—') + '</td>'
      + '<td>' + esc(c.projects || '—') + '</td>'
      + '<td>' + esc(c.lastContact || '—') + '</td>'
      + '<td>' + (c.followupDays || 14) + ' 天</td>'
      + '<td>' + dueChip + '</td>'
      + '<td><div style="display:flex;gap:5px;">'
      + '<button class="btn teal" style="padding:3px 9px;font-size:11.5px;" onclick="logContactInteraction(' + c.id + ')">✅ 今天沟通过了</button>'
      + '<button class="btn ghost" style="padding:3px 9px;font-size:11.5px;" onclick="openContactModal(' + c.id + ')">✎</button>'
      + '<button class="btn danger ghost" style="padding:3px 9px;font-size:11.5px;" onclick="deleteContactFlow(' + c.id + ')">✕</button>'
      + '</div></td></tr>';
  });
  h += '</tbody></table></div>';
  h += '<div class="empty" style="padding:8px 4px;">「✅ 今天沟通过了」= 记录一次互动，跟进周期重新起算；到期的联系人会在启动时自动生成「跟进：某人」任务进收件箱/项目。</div>';
  box.innerHTML = h;
}
function openContactModal(id) {
  const c = id ? S.contacts.find(x => x.id == id) : null;
  $id('ct-id').value = c ? c.id : '';
  $id('ct-name').value = c ? c.name : '';
  $id('ct-org').value = c ? c.org : '';
  $id('ct-tags').value = c ? c.tags : '';
  $id('ct-projects').value = c ? c.projects : '';
  $id('ct-last').value = c ? (c.lastContact || TODAY) : TODAY;
  $id('ct-days').value = c ? (c.followupDays || 14) : 14;
  $id('ct-note').value = c ? c.note : '';
  $id('ct-del').hidden = !c;
  openModal('mw-contact');
  setTimeout(() => $id('ct-name').focus(), 30);
}
async function saveContactModal() {
  const name = $id('ct-name').value.trim();
  if (!name) { toast('姓名不能为空', 'err'); return; }
  const c = {
    id: +$id('ct-id').value || 0, name: name, org: $id('ct-org').value.trim(),
    tags: $id('ct-tags').value.trim(), projects: $id('ct-projects').value.trim(),
    note: $id('ct-note').value.trim(), lastContact: $id('ct-last').value || TODAY,
    followupDays: +$id('ct-days').value || 14, createdAt: ''
  };
  try {
    const saved = await invoke('upsert_contact', { c: c });
    const i = S.contacts.findIndex(x => x.id == saved.id);
    if (i >= 0) S.contacts[i] = saved; else S.contacts.push(saved);
    closeModal('mw-contact');
    render();
    await generateFollowupTasks();
    toast('干系人已保存：' + name);
  } catch (e) { toastErr('保存失败', e); }
}
async function deleteContactFlow(id) {
  const c = S.contacts.find(x => x.id == id); if (!c) return;
  const ok = await askConfirm('删除干系人', '删除「' + c.name + '」的档案？已生成的跟进任务不受影响。', true);
  if (!ok) return;
  try {
    await invoke('delete_contact', { id: id });
    S.contacts = S.contacts.filter(x => x.id != id);
    render();
  } catch (e) { toastErr('删除失败', e); }
}
async function logContactInteraction(id) {
  const c = S.contacts.find(x => x.id == id); if (!c) return;
  c.lastContact = TODAY;
  try {
    const saved = await invoke('upsert_contact', { c: c });
    const i = S.contacts.findIndex(x => x.id == saved.id);
    if (i >= 0) S.contacts[i] = saved;
    render();
    toast('已记录今天与「' + c.name + '」的沟通，' + (c.followupDays || 14) + ' 天后会提醒跟进');
  } catch (e) { toastErr('记录失败', e); }
}
/* 到期干系人 → 自动生成「跟进：某人」任务（幂等：按标记 👤跟进:id 去重） */
async function generateFollowupTasks() {
  if (!S.contacts.length) return;
  let created = 0;
  for (const c of S.contacts) {
    if (contactDueDays(c) > 0) continue;
    const marker = '👤跟进:' + c.id;
    if (S.tasks.some(t => isOpen(t) && (t.note || '').indexOf(marker) >= 0)) continue;
    let pid = 0;
    if (c.projects) {
      const first = c.projects.split(/[,，、]/)[0].trim();
      const p = S.projects.find(x => !x.archived && x.name.indexOf(first) >= 0);
      if (p) pid = p.id;
    }
    try {
      await persistTask({
        id: 0, projectId: pid, title: '跟进：' + c.name + (c.org ? '（' + c.org + '）' : ''),
        due: TODAY, owner: '我方', pri: 'P1', status: 'todo', doneAt: '', risk: false, repeat: '',
        note: '干系人跟进 · 周期 ' + (c.followupDays || 14) + ' 天 · 上次沟通 ' + (c.lastContact || '无记录') + ' ' + marker,
        createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
      });
      created++;
    } catch (e) {}
  }
  if (created) toast('👥 有 ' + created + ' 位干系人到了跟进时间，已生成跟进任务', 'info');
}

/* ============ 包4 #16：每日笔记（复用日报引擎聚合当日信息） ============ */
function dailyNoteNav(delta) {
  S.noteDate = addDays(S.noteDate, delta);
  renderView();
}
async function dailyNoteGoToday() {
  S.noteDate = TODAY;
  renderView();
}
async function saveDailyNoteText() {
  const ta = $id('dn-text');
  if (!ta) return;
  try {
    await invoke('set_meta', { key: 'dailyNote_' + S.noteDate, value: ta.value });
    toast('每日笔记已保存');
    renderView();
  } catch (e) { toastErr('保存失败', e); }
}
async function renderDailyNote() {
  const box = $id('viewDailyNote');
  const date = S.noteDate;
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  const doneTasks = S.tasks.filter(t => t.status === 'done' && (t.doneAt || '').slice(0, 10) === date && archIds.indexOf(t.projectId) < 0);
  const dueTasks = S.tasks.filter(t => isOpen(t) && t.due === date && archIds.indexOf(t.projectId) < 0);
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  const meetings = S.meetings.filter(m => m.date === date);
  const shut = await getShutdownMeta(date);
  let logs = [];
  try { logs = await invoke('get_time_logs', { since: date }) || []; } catch (e) {}
  const mins = logs.filter(l => l.date === date).reduce((x, l) => x + (l.minutes || 0), 0);
  const myNote = await invoke('get_meta', { key: 'dailyNote_' + date }).catch(() => '') || '';

  let h = '<div class="cal-head">'
    + '<button class="btn ghost" onclick="dailyNoteNav(-1)">‹</button>'
    + '<b class="cal-title">' + date + (date === TODAY ? '（今天）' : '') + '</b>'
    + '<button class="btn ghost" onclick="dailyNoteNav(1)">›</button>'
    + '<button class="btn ghost" onclick="dailyNoteGoToday()">今天</button>'
    + '<span class="flex1"></span>'
    + (mins ? '<span class="chip2 cd">⏳ 投入 ' + (mins / 60).toFixed(1) + ' 小时</span>' : '')
    + '</div>';

  h += '<div class="dn-grid">';
  h += '<div class="stat-panel"><h3>🐸 今日三件要事</h3>'
    + (date === TODAY && frogs.length ? frogs.map(t => '<div class="dn-row">🐸 ' + esc(t.title) + '</div>').join('') : '<div class="empty">（当日未设置青蛙）</div>') + '</div>';
  h += '<div class="stat-panel"><h3>✅ 当日完成（' + doneTasks.length + '）</h3>'
    + (doneTasks.length ? doneTasks.map(t => '<div class="dn-row">✔ <span class="dim">' + esc(projNameOf(t.projectId)) + '</span> ' + esc(t.title) + '</div>').join('') : '<div class="empty">无</div>') + '</div>';
  h += '<div class="stat-panel"><h3>📆 当日到期（' + dueTasks.length + '）</h3>'
    + (dueTasks.length ? dueTasks.slice(0, 10).map(t => '<div class="dn-row">▸ <span class="dim">' + esc(projNameOf(t.projectId)) + '</span> ' + esc(t.title) + (t.status === 'doing' ? ' 🔨' : '') + '</div>').join('') + (dueTasks.length > 10 ? '<div class="empty">…还有 ' + (dueTasks.length - 10) + ' 条</div>' : '') : '<div class="empty">无</div>') + '</div>';
  h += '<div class="stat-panel"><h3>🗂 当日会议（' + meetings.length + '）</h3>'
    + (meetings.length ? meetings.map(m => '<div class="dn-row" onclick="openMeetingModal(' + m.id + ')" style="cursor:pointer;">🗂 ' + esc(m.title) + ' <span class="dim">' + esc(m.attendees || '') + '</span></div>').join('') : '<div class="empty">无</div>') + '</div>';
  h += '<div class="stat-panel"><h3>🌙 收尾问答</h3>'
    + (shut ? '<div class="dn-row">★ 干成：' + esc(shut.done || '—') + '</div><div class="dn-row">⛔ 卡点：' + esc(shut.stuck || '—') + '</div><div class="dn-row">⛔ 阻碍：' + esc(shut.block || '—') + '</div><div class="dn-row">➡ 明日：' + esc((shut.next3 || '').replace(/\n/g, ' / ')) + '</div>' : '<div class="empty">（当日未做收尾问答）</div>') + '</div>';
  h += '</div>';

  h += '<div class="stat-panel"><h3>📝 我的笔记（Markdown，Obsidian Daily Notes 模式）</h3>'
    + '<textarea id="dn-text" rows="6" placeholder="记录当天的过程、判断、待查线索…支持 Markdown 列表 / 粗体 / [[任务标题]] 反链">' + esc(myNote) + '</textarea>'
    + '<div style="margin-top:8px;display:flex;gap:8px;"><button class="btn blue" onclick="saveDailyNoteText()">💾 保存笔记</button>'
    + '<span class="hint">[[任务标题]] 会自动成为反链；保存后出现在引用它的任务详情里</span></div>'
    + (myNote ? '<div class="mdview" style="margin-top:10px;">' + mdRender(myNote) + '</div>' : '')
    + '</div>';
  box.innerHTML = h;
}

/* ============ 包4 #17：专注会话（全屏视图 + 可选倒计时 + 一句收尾） ============ */
let focusTickTimer = null;
function openFocusOverlay() {
  if (!S.timer) { toast('先在任务卡上点 ⏱ 开始计时', 'info'); return; }
  const t = getTask(S.timer.taskId);
  $id('fc-task').textContent = t ? t.title : '（任务不存在）';
  $id('fc-time').textContent = timerText(S.timer.startedAt);
  $id('fc-wrap').hidden = true;
  document.querySelector('input[name="fc-mode"][value="up"]').checked = true;
  openModal('mw-focus');
  if (focusTickTimer) clearInterval(focusTickTimer);
  focusTickTimer = setInterval(focusTick, 500);
  focusTick();
}
function focusMode() {
  const el = document.querySelector('input[name="fc-mode"]:checked');
  return el ? el.value : 'up';
}
function focusTotalSecs() {
  return (+$id('fc-mins').value || 25) * 60;
}
function focusTick() {
  if (!S.timer) { closeFocusOverlay(); return; }
  const t = getTask(S.timer.taskId);
  $id('fc-task').textContent = t ? t.title : '（任务不存在）';
  const now = Math.floor(Date.now() / 1000);
  if (focusMode() === 'down') {
    const total = focusTotalSecs();
    const elapsed = now - S.timer.startedAt;
    const remain = Math.max(0, total - elapsed);
    const m = Math.floor(remain / 60), s = remain % 60;
    $id('fc-time').textContent = pad(Math.floor(remain / 3600)) + ':' + pad(m) + ':' + pad(s);
    $id('fc-bar').style.width = Math.min(100, Math.round(elapsed / total * 100)) + '%';
    if (remain <= 0) { focusFinish(); return; }
  } else {
    $id('fc-time').textContent = timerText(S.timer.startedAt);
    $id('fc-bar').style.width = '0%';
  }
}
async function focusFinish() {
  if (focusTickTimer) { clearInterval(focusTickTimer); focusTickTimer = null; }
  const t = getTask(S.timer ? S.timer.taskId : 0);
  try {
    const mins = await invoke('stop_timer');
    S.timer = null;
    updateTimerBar();
    $id('fc-wrap').hidden = false;
    window._fcLastMins = mins;
    window._fcLastTask = t ? t.title : '';
    if (window.__TAURI__.core && !window.__TAURI__._isMock) { try { await invoke('notify_desktop', { title: '专注完成', body: '本轮 ' + mins + ' 分钟，写一句收尾吧' }); } catch (e) {} }
  } catch (e) { toastErr('停止计时失败', e); closeModal('mw-focus'); }
  render();
  updateTaskbarProgress();
}
async function saveFocusNote() {
  const note = $id('fc-note').value.trim();
  closeModal('mw-focus');
  $id('fc-note').value = '';
  if (!note) return;
  const line = '- [专注 ' + (window._fcLastMins || 0) + ' 分钟] ' + note + (window._fcLastTask ? '（' + window._fcLastTask + '）' : '');
  try {
    const key = 'dailyNote_' + TODAY;
    const cur = await invoke('get_meta', { key: key }).catch(() => '') || '';
    const val = cur ? cur + '\n' + line : line;
    await invoke('set_meta', { key: key, value: val });
    toast('已写入每日笔记：' + note.slice(0, 20));
    if (S.mode === 'dailynote') renderView();
  } catch (e) { toastErr('写入笔记失败', e); }
}
function closeFocusOverlay() {
  if (focusTickTimer) { clearInterval(focusTickTimer); focusTickTimer = null; }
  closeModal('mw-focus');
}

/* ============ 包2 #6：任务栏进度条 ============ */
let _lastTb = null;
async function updateTaskbarProgress() {
  let want = null;
  if (S.timer && $id('mw-focus') && !$id('mw-focus').hidden && focusMode() === 'down') {
    const total = focusTotalSecs();
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - S.timer.startedAt);
    want = { mode: 'normal', value: Math.min(100, Math.round(elapsed / total * 100)) };
  } else if (S.timer) {
    want = { mode: 'indeterminate', value: 0 };
  } else if (S.dailyGoal > 0) {
    const doneToday = S.tasks.filter(t => t.status === 'done' && (t.doneAt || '').slice(0, 10) === TODAY).length;
    want = { mode: 'normal', value: Math.min(100, Math.round(doneToday / S.dailyGoal * 100)) };
  } else {
    want = { mode: 'none', value: 0 };
  }
  const sig = want.mode + ':' + want.value;
  if (sig === _lastTb) return;
  _lastTb = sig;
  try { await invoke('taskbar_progress', { mode: want.mode, value: want.value }); } catch (e) {}
}


async function askReminderTime() {
  let cur = '';
  try { cur = await invoke('get_meta', { key: 'notifyTime' }) || ''; } catch (e) {}
  const v = await askPrompt('每日定时提醒',
    '到点通知今日到期任务，如 09:30；输入 off 关闭。当前：' + (cur || '关闭'), cur || '09:30');
  if (v === null) return;
  const s = v.trim();
  if (!s || s.toLowerCase() === 'off') {
    await invoke('set_meta', { key: 'notifyTime', value: '' }).catch(e => toastErr('保存失败', e));
    updateRemindBtn('');
    toast('每日提醒已关闭', 'info');
    return;
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) { toast('格式不对，示例：09:30', 'err'); return; }
  const norm = (/^\d:/).test(s) ? '0' + s : s;
  await invoke('set_meta', { key: 'notifyTime', value: norm }).catch(e => toastErr('保存失败', e));
  updateRemindBtn(norm);
  toast('每天 ' + norm + ' 会提醒你过一遍今日待办（保持软件开机自启更可靠）');
}
function updateRemindBtn(v) {
  $id('btnRemind').title = '每日定时提醒：' + (v ? v : '未设置（点击配置）');
  $id('btnRemind').classList.toggle('on', !!v);
}

/* ============ 包4 #15：项目 one-pager（档案视图） ============ */
function renderArchive() {
  const p = curProject(); if (!p) return;
  const s = parseSettings(p);
  const ts = projTasks(p.id);
  const open = ts.filter(t => isOpen(t)).sort(cmpTask);
  const done = ts.filter(t => t.status === 'done');
  const risks = open.filter(t => t.risk).sort((a, b) => riskValue(b) - riskValue(a));
  let h = '<div class="dec-head">'
    + '<span class="chip2 cd">📄 项目档案 · ' + esc(p.name) + '</span>'
    + '<button class="btn ghost" onclick="toggleOnePagerEditor()">✏️ 编辑一页纸</button>'
    + '<button class="btn ghost" onclick="exportProjectMd()">📤 整项目导出 Markdown（Obsidian）</button>'
    + '<button class="btn ghost" onclick="exportProjectXlsx()">📤 导出 .xlsx 计划表</button>'
    + '</div>';
  h += '<div class="stat-panel"><h3>一页纸（背景 / 目标 / 干系人 / 关键决策，支持 Markdown 与 [[反链]]）</h3>';
  h += '<div id="op-view" class="mdview">' + (s.onePager.trim() ? mdRender(s.onePager) : '<div class="empty">尚未撰写。点「✏️ 编辑一页纸」写下项目背景与目标，新人交接 / 向领导汇报一页讲清。</div>') + '</div>';
  h += '<div id="op-editor" hidden style="margin-top:10px;">'
    + '<textarea id="op-text" rows="8" placeholder="# 项目背景\n- 为什么立项、甲方是谁\n\n# 目标\n- 验收标准\n\n# 干系人\n- 决策人：[[某人]]\n\n# 关键决策\n- 引用决策日志里的 [[决策标题]]">' + esc(s.onePager) + '</textarea>'
    + '<div style="margin-top:8px;"><button class="btn blue" onclick="saveOnePager()">💾 保存</button> <button class="btn ghost" onclick="toggleOnePagerEditor()">取消</button></div></div>';
  h += '</div>';

  /* 任务总表 */
  h += '<div class="stat-panel"><h3>任务总表（未完成 ' + open.length + ' / 已完成 ' + done.length + '）</h3><table class="riskreg-table"><thead><tr><th>任务</th><th>负责人</th><th>优先级</th><th>截止</th><th>状态</th></tr></thead><tbody>'
    + (open.slice(0, 30).map(t => '<tr onclick="openTaskEdit(' + t.id + ')" style="cursor:pointer;"><td>' + esc(t.title) + '</td><td>' + esc(t.owner || '我方') + '</td><td>' + esc(t.pri || 'P1') + '</td><td>' + esc(t.due) + '</td><td>' + ({ todo: '待办', doing: '🔨 进行中', wait: '⏳ 等待' }[t.status] || '') + '</td></tr>').join('') || '<tr><td colspan="5" class="empty">无未完成任务</td></tr>')
    + '</tbody></table></div>';
  /* 风险册 */
  h += '<div class="stat-panel"><h3>风险册（' + risks.length + '）</h3>'
    + (risks.length ? '<table class="riskreg-table"><thead><tr><th>风险</th><th>风险值</th><th>应对</th><th>升级条件</th></tr></thead><tbody>'
      + risks.map(t => '<tr onclick="openTaskEdit(' + t.id + ')" style="cursor:pointer;"><td>' + esc(t.title) + '</td><td><b>' + (riskValue(t) || '—') + '</b></td><td>' + esc(t.riskMitigate || '—') + '</td><td>' + esc(t.riskEscalate || '—') + '</td></tr>').join('')
      + '</tbody></table>' : '<div class="empty">无开放风险</div>') + '</div>';
  /* 交付预测 brief + 统计 */
  const fc = monteCarloForecast(p.id, Math.max(1, open.filter(t => t.status !== 'wait').length));
  h += '<div class="stat-panel"><h3>交付预测 & 统计速览</h3><div class="chips-line">';
  if (fc.ok) h += '<span class="chip2 cd">🎯 剩余 ' + fc.remaining + ' 项：50% 于 ' + fc.p50 + ' · 85% 于 ' + fc.p85 + (fc.weekly ? '' : ' · 95% 于 ' + fc.p95) + '</span>';
  h += '<span class="chip2 good">已完成 ' + done.length + '</span>'
    + '<span class="chip2">未完成 ' + open.length + '</span>'
    + '<span class="chip2 warn">风险 ' + risks.length + '</span>'
    + '<span class="chip2">🏛 决策 ' + S.decisions.filter(d => d.projectId == p.id).length + ' 条</span>';
  h += '</div></div>';
  $id('viewArchive').innerHTML = h;
}
function toggleOnePagerEditor() {
  const p = curProject(); if (!p) return;
  const ed = $id('op-editor'), vw = $id('op-view');
  if (ed.hidden) {
    const s = parseSettings(p);
    $id('op-text').value = s.onePager || '';
    ed.hidden = false; vw.hidden = true;
  } else {
    ed.hidden = true; vw.hidden = false;
  }
}
async function saveOnePager() {
  const p = curProject(); if (!p) return;
  const s = parseSettings(p);
  s.onePager = $id('op-text').value;
  p.settingsJson = JSON.stringify(s);
  try {
    await persistProject(p);
    toast('一页纸已保存');
    renderView();
  } catch (e) { toastErr('保存失败', e); }
}
/* 包4 #18：整项目导出 Markdown（每任务一文件 + 项目主页） */
async function exportProjectMd() {
  const p = curProject(); if (!p) return;
  let dir = null;
  try {
    dir = await TDialog().open({ title: '选择导出位置（会在其中创建项目文件夹）', directory: true, multiple: false });
  } catch (e) { toastErr('打开目录选择失败', e); return; }
  if (!dir) { toast('已取消导出', 'info'); return; }
  try {
    const out = await invoke('export_project_md', { dir: dir, projectId: p.id });
    toast('📦 已导出到：' + out + '（项目主页.md + tasks/ 目录 + 决策日志.md）');
  } catch (e) { toastErr('导出失败', e); }
}

/* ============ 包6：时间线甘特视图（自绘 SVG，只读+轻编辑+导出PNG） ============ */
const GANTT_ZOOM = { day: { px: 34 }, week: { px: 12 }, month: { px: 4 } };
function ganttState() {
  if (!S.ganttZoom) S.ganttZoom = 'day';
  if (!S.ganttPx) S.ganttPx = GANTT_ZOOM[S.ganttZoom].px;
  return S.ganttPx;
}
function ganttBarDates(t) {
  /* start 回退链：start_date → due-2 天 → created_at → 今天 */
  let start = t.startDate;
  if (!start && t.due) start = addDays(t.due, -2);
  if (!start) start = (t.createdAt || TODAY).slice(0, 10);
  const due = t.due || start;
  return { start: start <= due ? start : due, due: due };
}
/* 树序：父任务在前，子任务缩进；父任务条 = min(子start)~max(子due) + 进度上卷 */
function ganttRows(pid) {
  const ts = projTasks(pid);
  const roots = ts.filter(t => !t.parentId);
  const rows = [];
  const seen = []; /* 防御：脏数据成环时避免无限递归把时间线视图打崩 */
  const addTask = (t, depth) => {
    if (seen.indexOf(t.id) >= 0) return;
    seen.push(t.id);
    const subs = subTasksOf(t.id);
    let roll = null;
    if (subs.length) {
      let mn = null, mx = null;
      subs.forEach(s2 => {
        const d2 = ganttBarDates(s2);
        if (!mn || d2.start < mn) mn = d2.start;
        if (!mx || d2.due > mx) mx = d2.due;
      });
      const r = rollupSummary(t);
      roll = { start: mn, due: mx, pct: r && r.total ? Math.round(r.done / r.total * 100) : 0 };
    }
    rows.push({ t: t, depth: depth, isParent: subs.length > 0, roll: roll });
    subs.forEach(s2 => addTask(s2, depth + 1));
  };
  roots.forEach(t => addTask(t, 0));
  return rows;
}
function renderTimeline() {
  const p = curProject(); if (!p) return;
  const px = ganttState();
  const rows = ganttRows(p.id);
  const rowH = 30, headerH = 44, labelW = 250;
  /* 时间窗口：所有条的 min~max ± 7 天，并包含今天 */
  let mn = TODAY, mx = TODAY;
  rows.forEach(r => {
    const d = r.roll || ganttBarDates(r.t);
    if (d.start < mn) mn = d.start;
    if (d.due > mx) mx = d.due;
  });
  mn = addDays(mn, -7); mx = addDays(mx, 7);
  if (!S.ganttOffset) S.ganttOffset = 0;
  /* 左右平移必须同时移动起止，否则窗口越移越窄、最终画到可视区外整图空白 */
  mn = addDays(mn, S.ganttOffset * 14);
  mx = addDays(mx, S.ganttOffset * 14);
  const nDays = Math.max(14, Math.round((new Date(mx) - new Date(mn)) / 86400000) + 1);
  const gridW = nDays * px;
  const svgH = headerH + rows.length * rowH + 8;
  const dayX = d => Math.round((new Date(d) - new Date(mn)) / 86400000) * px;

  /* SVG 字符串（内联样式，便于导出 PNG） */
  const sv = [];
  sv.push('<svg id="gantt-svg" xmlns="http://www.w3.org/2000/svg" width="' + (gridW) + '" height="' + svgH + '" style="display:block;background:var(--panel);font-family:Segoe UI,Microsoft YaHei,sans-serif">');
  /* 表头 */
  sv.push('<rect x="0" y="0" width="' + gridW + '" height="' + headerH + '" fill="#f6f8fb"/>');
  if (S.ganttZoom === 'day') {
    for (let i = 0; i < nDays; i++) {
      const d = addDays(mn, i);
      const dow = new Date(d).getDay();
      const x = i * px;
      if (dow === 0 || dow === 6) sv.push('<rect x="' + x + '" y="' + headerH + '" width="' + px + '" height="' + (svgH - headerH) + '" fill="rgba(122,132,158,.07)"/>');
      const isToday = d === TODAY;
      sv.push('<text x="' + (x + px / 2) + '" y="16" text-anchor="middle" font-size="10" fill="' + (isToday ? '#4c6ef5' : '#77809a') + '">' + d.slice(8) + '</text>');
      if (d.slice(8) === '01' || i === 0) sv.push('<text x="' + (x + 3) + '" y="32" text-anchor="start" font-size="10" font-weight="bold" fill="#77809a">' + d.slice(0, 7) + '</text>');
      sv.push('<line x1="' + x + '" y1="' + headerH + '" x2="' + x + '" y2="' + svgH + '" stroke="rgba(229,233,241,.8)" stroke-width="1"/>');
    }
  } else {
    const step = S.ganttZoom === 'week' ? 7 : 1;
    let lastMonth = '';
    for (let i = 0; i < nDays; i += step) {
      const d = addDays(mn, i);
      const x = i * px;
      const w = step * px;
      const isToday = d === TODAY || (S.ganttZoom === 'month' && d.slice(0, 7) === TODAY.slice(0, 7) && addDays(d, step - 1) >= TODAY);
      if (S.ganttZoom === 'week') sv.push('<rect x="' + x + '" y="' + headerH + '" width="' + w + '" height="' + (svgH - headerH) + '" fill="' + (Math.floor(i / 7) % 2 ? 'rgba(122,132,158,.05)' : 'transparent') + '"/>');
      sv.push('<text x="' + (x + w / 2) + '" y="16" text-anchor="middle" font-size="10" fill="' + (isToday ? '#4c6ef5' : '#77809a') + '">' + (S.ganttZoom === 'week' ? d.slice(5) : d.slice(0, 7)) + '</text>');
      if (d.slice(0, 7) !== lastMonth) { sv.push('<text x="' + (x + 3) + '" y="32" font-size="11" font-weight="bold" fill="#77809a">' + d.slice(0, 7) + '</text>'); lastMonth = d.slice(0, 7); }
      sv.push('<line x1="' + x + '" y1="' + headerH + '" x2="' + x + '" y2="' + svgH + '" stroke="rgba(229,233,241,.8)"/>');
    }
  }
  /* 今日线 */
  const tx = dayX(TODAY);
  if (tx >= 0 && tx <= gridW) sv.push('<line x1="' + tx + '" y1="0" x2="' + tx + '" y2="' + svgH + '" stroke="#e03131" stroke-width="1.5" stroke-dasharray="4 3"/><text x="' + (tx + 3) + '" y="' + (headerH - 4) + '" font-size="10" fill="#e03131">今天</text>');
  /* 条 */
  rows.forEach((r, i) => {
    const y = headerH + i * rowH + 6;
    sv.push('<line x1="0" y1="' + (y - 6 + rowH) + '" x2="' + gridW + '" y2="' + (y - 6 + rowH) + '" stroke="rgba(229,233,241,.5)"/>');
    const t = r.t;
    const d = r.roll || ganttBarDates(t);
    const bx = dayX(d.start), bx2 = dayX(d.due) + px;
    const bw = Math.max(6, bx2 - bx);
    const hgt = r.isParent ? 10 : 16;
    const by = r.isParent ? y + 4 : y + 2;
    let fill = '#7b849e';
    if (t.status === 'done') fill = '#2f9e44';
    else if (t.status === 'doing') fill = '#4c6ef5';
    else if (t.status === 'wait') fill = '#f08c00';
    else if (t.isMilestone) fill = '#9775fa';
    if (t.isMilestone && !r.isParent) {
      const cx = dayX(t.due || ganttBarDates(t).due) + px / 2, cy = y + 9;
      sv.push('<path d="M ' + cx + ' ' + (cy - 9) + ' L ' + (cx + 9) + ' ' + cy + ' L ' + cx + ' ' + (cy + 9) + ' L ' + (cx - 9) + ' ' + cy + ' Z" fill="' + (t.status === 'done' ? '#2f9e44' : '#9775fa') + '"><title>' + esc(t.title) + '（里程碑 ' + (t.due || '') + '）</title></path>');
      return;
    }
    const cls = isOpen(t) && t.status !== 'wait' && t.due && t.due < TODAY ? ' gantt-over' : '';
    const stroke = cls ? '#e03131' : 'rgba(16,24,40,.18)';
    sv.push('<rect class="gbar' + cls + '" data-id="' + t.id + '" x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + hgt + '" rx="4" fill="' + fill + '" fill-opacity="' + (t.status === 'done' ? .55 : .92) + '" stroke="' + stroke + '" style="cursor:' + (r.isParent ? 'default' : 'grab') + '"><title>' + esc(t.title) + ' · ' + d.start + ' → ' + d.due + '</title></rect>');
    /* 进度填充 */
    let pct = 0;
    if (r.isParent && r.roll) pct = r.roll.pct;
    else if (t.status === 'done') pct = 100;
    else { const roll = rollupSummary(t); if (roll && roll.total) pct = Math.round(roll.done / roll.total * 100); else if (t.status === 'doing') pct = 50; }
    if (pct > 0) sv.push('<rect x="' + bx + '" y="' + by + '" width="' + Math.max(2, bw * pct / 100) + '" height="' + hgt + '" rx="4" fill="rgba(255,255,255,.55)" pointer-events="none"/>');
  });
  sv.push('</svg>');

  /* 左侧标签列（sticky） */
  let labels = '<div class="glabel head" style="height:' + headerH + 'px"></div>';
  rows.forEach(r => {
    const t = r.t;
    labels += '<div class="glabel' + (t.status === 'done' ? ' done' : '') + '" style="height:' + rowH + 'px;padding-left:' + (8 + r.depth * 16) + 'px;" onclick="openTaskEdit(' + t.id + ')" title="' + esc(t.title) + '">'
      + (r.isParent ? '📂 ' : t.isMilestone ? '🏁 ' : '▸ ')
      + '<span class="gl-t">' + esc(t.title) + '</span>'
      + '<span class="gl-o">' + esc(t.owner || '我方') + '</span></div>';
  });

  const h = '<div class="gantt-head">'
    + '<div class="tabs" style="padding:2px;">' + ['day', 'week', 'month'].map(z =>
      '<button data-zoom="' + z + '" class="' + (S.ganttZoom === z ? 'on' : '') + '" onclick="ganttSetZoom(\'' + z + '\')">' + ({ day: '日', week: '周', month: '月' })[z] + '</button>').join('') + '</div>'
    + '<button class="btn ghost" onclick="ganttPan(-1)">‹ 左移</button><button class="btn ghost" onclick="ganttPan(1)">右移 ›</button>'
    + '<span class="chip2">拖条改日期 · 拖右边缘改截止 · 拖左边缘改开始</span>'
    + '<span class="chip2">🏁 里程碑 = 编辑任务勾选「里程碑」</span>'
    + '<span class="flex1"></span>'
    + '<button class="btn teal" onclick="exportGanttPng()">📸 导出 PNG 发领导</button>'
    + '</div>'
    + '<div class="gantt-scroll"><div class="gantt-inner" style="grid-template-columns:' + labelW + 'px ' + gridW + 'px;">'
    + '<div class="gantt-labels">' + labels + '</div>'
    + sv.join('')
    + '</div></div>';
  $id('viewTimeline').innerHTML = h;
  bindGanttDrag();
}
function ganttSetZoom(z) {
  S.ganttZoom = z;
  S.ganttPx = GANTT_ZOOM[z].px;
  S.ganttOffset = 0;
  renderView();
}
function ganttPan(dir) {
  S.ganttOffset = (S.ganttOffset || 0) + dir;
  renderView();
}
/* 甘特拖拽：拖条移动 / 左右边缘改日期（吸附到天，复用看板指针拖拽思路） */
let gdrag = null;
function bindGanttDrag() {
  const svg = $id('gantt-svg');
  if (!svg) return;
  svg.addEventListener('mousedown', e => {
    const bar = e.target.closest ? e.target.closest('.gbar') : null;
    if (!bar) return;
    const id = +bar.getAttribute('data-id');
    const t = getTask(id);
    if (!t || subTasksOf(t.id).length) return; /* 父任务条是上卷结果，不允许拖 */
    const rect = bar.getBoundingClientRect();
    let mode = 'move';
    if (e.clientX - rect.left <= 7) mode = 'resize-l';
    else if (rect.right - e.clientX <= 7) mode = 'resize-r';
    const d0 = ganttBarDates(t);
    gdrag = { id, mode, startX: e.clientX, start: d0.start, due: d0.due, px: ganttState(), bar };
    e.preventDefault();
    e.stopPropagation();
  });
}
document.addEventListener('mousemove', e => {
  if (!gdrag) return;
  const delta = Math.round((e.clientX - gdrag.startX) / gdrag.px);
  if (delta === 0 && !gdrag.moved) return;
  gdrag.moved = true;
  const t = getTask(gdrag.id);
  if (!t) return;
  let { start, due } = gdrag;
  if (gdrag.mode === 'move') { start = addDays(gdrag.start, delta); due = addDays(gdrag.due, delta); }
  else if (gdrag.mode === 'resize-r') { due = addDays(gdrag.due, delta); if (due < start) due = start; }
  else { start = addDays(gdrag.start, delta); if (start > due) start = due; }
  gdrag.ns = start; gdrag.nd = due;
  gdrag.bar.setAttribute('title', t.title + ' · ' + start + ' → ' + due);
});
document.addEventListener('mouseup', async e => {
  if (!gdrag) return;
  const g = gdrag; gdrag = null;
  if (!g.moved || g.ns == null) return;
  const t = getTask(g.id);
  if (!t) return;
  t.startDate = g.ns;
  t.due = g.nd;
  try {
    await persistTask(t);
    toast('📅 「' + t.title.slice(0, 14) + '」已调整为 ' + g.ns + ' → ' + g.nd);
    renderView();
  } catch (err) { toastErr('保存失败', err); }
});
/* 导出 PNG：SVG 序列化 → img → canvas 2x 高清 → 写盘（零依赖方案） */
async function exportGanttPng() {
  const svg = $id('gantt-svg');
  const p = curProject();
  if (!svg || !p) return;
  try {
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.style.background = '#ffffff';
    clone.querySelectorAll('[fill="var(--panel)"]').forEach(el => el.setAttribute('fill', '#ffffff'));
    clone.querySelectorAll('[fill="#f6f8fb"]').forEach(el => el.setAttribute('fill', '#f2f4f8'));
    let str = new XMLSerializer().serializeToString(clone);
    str = str.replace(/var\(--panel\)/g, '#ffffff');
    const scale = 2;
    const img = new Image();
    const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('SVG 渲染失败'));
      img.src = svg64;
    });
    const canvas = document.createElement('canvas');
    canvas.width = svg.width.baseVal.value * scale;
    canvas.height = svg.height.baseVal.value * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    let path = null;
    path = await TDialog().save({
      title: '导出时间线 PNG',
      defaultPath: p.name + '-时间线-' + TODAY + '.png',
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (!path) { toast('已取消导出', 'info'); return; }
    await invoke('save_binary_file', { path: path, dataBase64: dataUrl.split(',')[1] });
    toast('📸 已导出：' + path);
  } catch (e) { toastErr('导出 PNG 失败', e); }
}

/* ============ 包5：Excel 计划表导入向导（Jira 五步模式） ============ */
const XW_FIELDS = [
  { key: 'title', label: '标题（必填）', kw: /任务|事项|工作内容|名称|标题|内容/ },
  { key: 'due', label: '截止日期 → due', kw: /截止|完成时间|计划结束|结束时间|完成日期|交付/ },
  { key: 'start', label: '开始日期', kw: /开始|计划开始|启动/ },
  { key: 'owner', label: '负责人', kw: /负责人|责任人|owner|执行人|经办/ },
  { key: 'pri', label: '优先级', kw: /优先级|级别/ },
  { key: 'status', label: '状态 / 完成百分比', kw: /状态|完成|进度|百分比/ },
  { key: 'note', label: '备注 / 交付物', kw: /备注|说明|交付物|描述/ },
  { key: 'stage', label: '所属阶段（作父任务）', kw: /阶段|里程碑|wbs|模块/ }
];
const XW_STEPS = ['① 选文件', '② 选工作表', '③ 列映射', '④ 预览', '⑤ 导入'];
let XW = null;
function openExcelWizard() {
  XW = { step: 1, path: '', fileName: '', sheets: [], sheet: '', headerRow: 0, rows: null,
    map: {}, valueMap: {}, pctToStatus: true, targetMode: 'new', newProjName: '', targetPid: 0, sample: false, result: null };
  $id('xw-next').hidden = false;
  $id('xw-import').hidden = true;
  renderExcelWizard();
  openModal('mw-xlsx');
}
function xwStepsHtml() {
  return XW_STEPS.map((s, i) => '<span class="xw-step' + (XW.step === i + 1 ? ' on' : XW.step > i + 1 ? ' done' : '') + '">' + s + '</span>').join('<i class="xw-arrow">→</i>');
}
function renderExcelWizard() {
  $id('xw-steps').innerHTML = xwStepsHtml();
  $id('xw-next').hidden = !(XW.step >= 2 && XW.step < 5);
  $id('xw-import').hidden = XW.step !== 5;
  const body = $id('xw-body');
  window._xwStatus = (msg, isErr) => { const el = $id('xw-status'); el.textContent = msg || ''; el.style.color = isErr ? 'var(--red)' : ''; };
  if (XW.step === 1) {
    body.innerHTML = '<div class="xw-hint">支持 <b>.xlsx / .xls</b>（.csv / .et 建议先在 Excel/WPS 里另存为 xlsx）。解析全部在本机完成，不上传任何数据。</div>'
      + '<div style="display:flex;gap:10px;margin-top:14px;align-items:center;"><button class="btn blue" onclick="xwPickFile()">📂 选择计划表文件</button>'
      + (XW.fileName ? '<span class="chip2 cd">已选：' + esc(XW.fileName) + '</span>' : '') + '</div>'
      + '<div class="xw-hint" style="margin-top:14px;">针对中国计划表的脏数据策略：<b>合并单元格</b>自动向下填充首值；<b>WBS 层级</b>三路探测（序号列点分 1/1.1/1.1.2 · 缩进前导空格 · 独立「阶段」列合并单元格），阶段行→父任务（进度上卷自动算）；<b>混合日期</b> 2026-09-01 / 2026/9/1 / 9月1日 / Excel 序列号全兼容，"9月上旬"标黄人工处理；<b>完成百分比</b> 50% / 0.5 / "50" 统一归一，≥100%→已完成、1~99%→进行中；<b>前置任务列</b>原文写回备注不做依赖解析；<b>无日期列</b> due 默认今天并在预览提示。</div>';
  } else if (XW.step === 2) {
    body.innerHTML = '<label>工作表</label><select id="xw-sheet" onchange="xwSheetChanged()">' + (XW.sheets || []).map(s => '<option' + (s === XW.sheet ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>'
      + '<label>表头行（自动猜测，可手改）</label><select id="xw-hrow" onchange="xwHeaderChanged()">' + (XW._rowChoices || []).map((rc, i) => '<option value="' + i + '"' + (i === XW._rowChoiceIdx ? ' selected' : '') + '>' + esc(rc.label) + '</option>').join('') + '</select>'
      + '<div class="xw-preview">' + xwMatrixTable(XW.rows, 10, XW.headerRow) + '</div>';
  } else if (XW.step === 3) {
    const headers = XW.rows[XW.headerRow] || [];
    let h = '<div class="xw-maps">';
    XW_FIELDS.forEach(f => {
      h += '<div class="xw-map-row"><label>' + f.label + '</label><select id="xw-map-' + f.key + '" onchange="xwMapChanged()">'
        + '<option value="-1">（不导入）</option>'
        + headers.map((hd, ci) => '<option value="' + ci + '"' + (XW.map[f.key] === ci ? ' selected' : '') + '>' + (hd ? esc(String(hd).slice(0, 14)) : '列' + (ci + 1)) + '</option>').join('')
        + '</select></div>';
    });
    h += '</div>';
    const sIdx = XW.map.status;
    if (sIdx != null && sIdx >= 0) {
      const vals = [];
      for (let r = XW.headerRow + 1; r < XW.rows.length; r++) {
        const v = String((XW.rows[r] || [])[sIdx] || '').trim();
        if (v && vals.indexOf(v) < 0) vals.push(v);
        if (vals.length >= 24) break;
      }
      h += '<label class="xw-vm-title">值映射（Jira 特色：把表里的「已完成/100%/done」→已完成、「进行中/实施中」→进行中；留空 = 按关键词自动判断）</label><div class="xw-vmaps">';
      vals.forEach(v => {
        const auto = /完成|done|已|100|close/i.test(v) ? '已完成' : /进行|实施|doing|启动|开始/i.test(v) ? '进行中' : '待办';
        const key = v.replace(/"/g, '&quot;');
        h += '<div class="xw-map-row"><label title="' + esc(v) + '">' + esc(v.slice(0, 16)) + '</label><select onchange="xwValueMap(\'' + key.replace(/'/g, "\\'") + '\', this.value)">'
          + '<option value="">自动（→' + auto + '）</option>'
          + ['todo', 'doing', 'done'].map(s2 => '<option value="' + s2 + '"' + (XW.valueMap[v] === s2 ? ' selected' : '') + '>' + ({ todo: '待办', doing: '进行中', done: '已完成' })[s2] + '</option>').join('')
          + '<option value="skip"' + (XW.valueMap[v] === 'skip' ? ' selected' : '') + '>跳过该行</option></select></div>';
      });
      h += '</div><label class="ck big"><input type="checkbox" ' + (XW.pctToStatus ? 'checked' : '') + ' onchange="XW.pctToStatus=this.checked"> 完成百分比归一：≥100% → 已完成，1~99% → 进行中</label>';
    }
    h += '<div class="xw-preview">' + xwMatrixTable(XW.rows, 6, XW.headerRow) + '</div>';
    body.innerHTML = h;
  } else if (XW.step === 4) {
    const built = xwBuildImportRows();
    XW.built = built;
    const bad = built.filter(r => r.err).length, warn = built.filter(r => r.warn && !r.err).length;
    let h = '<div class="chips-line" style="margin-bottom:10px;">'
      + '<span class="chip2 good">✅ 可导入 ' + built.filter(r => !r.err).length + ' 行</span>'
      + (warn ? '<span class="chip2 warn">⚠ 警告 ' + warn + ' 行</span>' : '')
      + (bad ? '<span class="chip2 bad">⛔ 跳过 ' + bad + ' 行</span>' : '')
      + '<span class="chip2">阶段父任务 ' + built.filter(r => r.isStage).length + ' 个</span></div>';
    h += '<div class="xw-preview"><table><thead><tr><th>行</th><th>层级</th><th>标题</th><th>截止</th><th>负责人</th><th>状态</th><th>提示</th></tr></thead><tbody>';
    built.slice(0, 20).forEach(r => {
      h += '<tr class="' + (r.err ? 'xw-bad' : r.warn ? 'xw-warn' : '') + '"><td>' + (r.srcIdx + 1) + '</td><td>' + (r.isStage ? '📂 父' : r.parentTitle ? '↳' : '—') + '</td>'
        + '<td>' + esc(r.title || '（空标题）') + '</td><td>' + esc(r.due || '—') + '</td><td>' + esc(r.owner || '') + '</td><td>' + esc(r.status || 'todo') + '</td>'
        + '<td>' + (r.err ? '⛔ ' + esc(r.err) : r.warn ? '⚠ ' + esc(r.warn) : '') + '</td></tr>';
    });
    h += '</tbody></table>' + (built.length > 20 ? '<div class="empty">仅预览前 20 行，共 ' + built.length + ' 行</div>' : '') + '</div>';
    body.innerHTML = h;
  } else if (XW.step === 5) {
    const alive = S.projects.filter(p => !p.archived);
    body.innerHTML = '<label>导入到哪？</label>'
      + '<label class="ck big"><input type="radio" name="xw-target" value="new" ' + (XW.targetMode === 'new' ? 'checked' : '') + ' onchange="XW.targetMode=\'new\'"> 新建项目（名称默认取文件名）</label>'
      + '<div class="xw-map-row" style="margin-left:22px;"><input type="text" id="xw-newname" value="' + esc(XW.newProjName) + '" placeholder="项目名称"></div>'
      + '<label class="ck big"><input type="radio" name="xw-target" value="merge" ' + (XW.targetMode === 'merge' ? 'checked' : '') + ' onchange="XW.targetMode=\'merge\'"> 并入现有项目</label>'
      + '<div class="xw-map-row" style="margin-left:22px;"><select id="xw-targetpid" onchange="XW.targetPid=+this.value">' + alive.map(p => '<option value="' + p.id + '"' + (XW.targetPid == p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div>'
      + '<label class="ck big"><input type="checkbox" ' + (XW.sample ? 'checked' : '') + ' onchange="XW.sample=this.checked"> 🧪 先导到「示例项目」试一把（Jira 最佳实践：先试跑看效果）</label>'
      + '<div class="hint" style="margin-top:10px;">共 <b>' + (XW.built || []).filter(r => !r.err).length + '</b> 行待导入。完成后给导入报告（成功 N 条 / 跳过 M 条及原因）。</div>';
  }
}
async function xwPickFile() {
  let path = null;
  try {
    path = await TDialog().open({
      title: '选择 Excel 计划表',
      multiple: false,
      filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv', 'xlsm'] }]
    });
  } catch (e) { toastErr('打开文件对话框失败', e); return; }
  if (!path) return;
  XW.path = Array.isArray(path) ? path[0] : path;
  XW.fileName = String(XW.path).split(/[\\/]/).pop();
  XW.rows = null;
  try {
    if (/\.csv$/i.test(XW.fileName)) {
      XW._csv = true;
      XW.sheets = ['CSV'];
      XW.sheet = 'CSV';
    } else {
      XW._csv = false;
      XW.sheets = await invoke('xlsx_sheets', { path: XW.path });
      XW.sheet = XW.sheets[0] || '';
    }
  } catch (e) { toastErr('读取文件失败', e); return; }
  await xwLoadSheet();
  if (XW.newProjName === '') XW.newProjName = XW.fileName.replace(/\.[^.]+$/, '').replace(/[-_]?计划表?$/, '');
  XW.step = 2;
  renderExcelWizard();
}
async function xwLoadSheet() {
  try {
    if (XW._csv) {
      if (!XW.rows) {
        const raw = await invoke('read_text_file', { path: XW.path });
        XW.rows = parseCsvText(raw);
      }
    } else {
      const res = await invoke('xlsx_read', { path: XW.path, sheet: XW.sheet });
      XW.rows = res.rows || [];
    }
  } catch (e) { toastErr('解析失败', e); return; }
  /* 表头行自动猜测：首个含「任务/事项/工作内容/名称」类关键词的非空行 */
  const choices = [];
  for (let r = 0; r < Math.min(XW.rows.length, 15); r++) {
    const row = XW.rows[r] || [];
    const nonEmpty = row.filter(c => String(c).trim()).length;
    if (nonEmpty < 2) continue;
    const hitKw = row.some(c => /任务|事项|工作内容|名称|标题|阶段|负责人/.test(String(c)));
    choices.push({ idx: r, label: '第 ' + (r + 1) + ' 行' + (hitKw ? ' ⭐' : '') + '：' + row.filter(c => String(c).trim()).slice(0, 4).map(c => String(c).slice(0, 8)).join(' / ') });
  }
  if (!choices.length) choices.push({ idx: 0, label: '第 1 行' });
  XW._rowChoices = choices;
  XW._rowChoiceIdx = Math.max(0, choices.findIndex(c => /⭐/.test(c.label)));
  XW.headerRow = choices[XW._rowChoiceIdx].idx;
  xwAutoMap();
}
function xwSheetChanged() {
  XW.sheet = $id('xw-sheet').value;
  XW.rows = null;
  xwLoadSheet().then(() => renderExcelWizard());
}
function xwHeaderChanged() {
  XW._rowChoiceIdx = +$id('xw-hrow').value;
  XW.headerRow = XW._rowChoices[XW._rowChoiceIdx].idx;
  xwAutoMap();
  renderExcelWizard();
}
/* 自动预映射：按列名关键词猜（"截止/完成时间/计划结束"→due，"负责人/责任人/Owner"→负责人） */
function xwAutoMap() {
  const headers = (XW.rows && XW.rows[XW.headerRow]) || [];
  XW.map = {};
  XW_FIELDS.forEach(f => {
    const i = headers.findIndex(hd => f.kw.test(String(hd || '')));
    if (i >= 0) XW.map[f.key] = i;
  });
  if (XW.map.title == null) {
    const i = headers.findIndex(hd => String(hd || '').trim());
    if (i >= 0) XW.map.title = i;
  }
  XW.valueMap = {};
}
function xwMapChanged() {
  XW_FIELDS.forEach(f => { const el = $id('xw-map-' + f.key); if (el) XW.map[f.key] = +el.value; });
  renderExcelWizard();
}
function xwValueMap(v, val) { XW.valueMap[v] = val; }
/* 日期解析：ISO / 斜杠 / 9月1日 / 2026年9月1日 / Excel 序列号；模糊表述标黄 */
function xwParseDate(v) {
  const s = String(v || '').trim();
  if (!s) return { v: '' };
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) return { v: m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]) };
  m = s.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (m) return { v: TODAY.slice(0, 4) + '-' + pad(+m[1]) + '-' + pad(+m[2]) };
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.round(+s);
    if (n >= 40000 && n <= 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return { v: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) };
    }
  }
  if (/^[\d.]+$/.test(s)) return { v: '', warn: '日期列出现数字「' + s + '」，无法识别' };
  return { v: '', warn: '模糊日期「' + s.slice(0, 12) + '」，已留空待人工处理' };
}
function xwStatusOf(raw) {
  const s = String(raw || '').trim();
  if (!s) return { status: 'todo' };
  if (XW.valueMap[s]) {
    if (XW.valueMap[s] === 'skip') return { skip: true };
    return { status: XW.valueMap[s] };
  }
  if (/^(\d+(\.\d+)?)\s*%$/.test(s) || /^0\.\d+$/.test(s) || /^\d+$/.test(s)) {
    if (!XW.pctToStatus) return { status: 'todo' };
    let pct = /%/.test(s) ? parseFloat(s) : (+s <= 1 ? +s * 100 : +s);
    if (isNaN(pct)) return { status: 'todo' };
    if (pct >= 100) return { status: 'done', pctNote: s };
    if (pct >= 1) return { status: 'doing', pctNote: s };
    return { status: 'todo' };
  }
  if (/完成|done|已结|关闭|100/i.test(s)) return { status: 'done' };
  if (/进行|实施|doing|启动|开始|处理/i.test(s)) return { status: 'doing' };
  if (/等待|挂起|暂停|hold/i.test(s)) return { status: 'wait' };
  return { status: 'todo' };
}
/* 层级探测：序号点分（1 / 1.1 / 1.1.2）或缩进前导空格（OpenProject 4 空格规则） */
function xwDepthOf(title) {
  const t = String(title || '');
  const m = t.match(/^\s*(\d+(?:[.、]\d+)*)[、.\s]/);
  if (m) return m[1].split(/[.、]/).length;
  const indent = t.match(/^[ \t　]+/);
  if (indent) return Math.floor(indent[0].replace(/　/g, '  ').replace(/\t/g, '  ').length / 2) + 1;
  return 1;
}
function xwBuildImportRows() {
  const map = XW.map;
  const rows = [];
  if (map.title == null || map.title < 0) return rows;
  const useStage = map.stage != null && map.stage >= 0;
  const stageParents = {};
  const stack = []; /* 层级栈：parents */
  const preIdx = (XW.rows[XW.headerRow] || []).findIndex(hd => /前置|依赖/.test(String(hd || '')));
  for (let r = XW.headerRow + 1; r < XW.rows.length; r++) {
    const row = XW.rows[r] || [];
    const rawTitle = String(row[map.title] || '');
    if (!rawTitle.trim()) continue;
    const rec = { srcIdx: r, title: rawTitle.trim().replace(/\s+/g, ' '), due: '', startDate: '', owner: '', pri: 'P1', status: 'todo', note: '', isStage: false, parentTitle: '', err: '', warn: '' };
    if (map.due != null && map.due >= 0) { const d = xwParseDate(row[map.due]); rec.due = d.v; if (d.warn) rec.warn = d.warn; }
    if (map.start != null && map.start >= 0) { const d = xwParseDate(row[map.start]); rec.startDate = d.v; }
    if (map.owner != null && map.owner >= 0) rec.owner = String(row[map.owner] || '').trim().slice(0, 20);
    if (map.pri != null && map.pri >= 0) {
      const pm = String(row[map.pri] || '').toUpperCase().match(/P([012])/);
      if (pm) rec.pri = 'P' + pm[1];
    }
    if (map.status != null && map.status >= 0) {
      const st = xwStatusOf(row[map.status]);
      if (st.skip) continue;
      rec.status = st.status;
      if (st.pctNote) rec.warn = (rec.warn ? rec.warn + '；' : '') + '完成度 ' + st.pctNote + ' → ' + ({ done: '已完成', doing: '进行中' }[st.status] || st.status);
    }
    if (map.note != null && map.note >= 0) rec.note = String(row[map.note] || '').trim().slice(0, 500);
    if (preIdx >= 0 && row[preIdx]) rec.note = (rec.note ? rec.note + '\n' : '') + '前置：' + String(row[preIdx]).trim();
    if (!rec.title) { rec.err = '标题为空'; rows.push(rec); continue; }
    if (useStage) {
      const stage = String(row[map.stage] || '').trim();
      if (stage) {
        if (!stageParents[stage]) {
          stageParents[stage] = { srcIdx: r, title: stage, due: '', startDate: '', owner: '', pri: 'P1', status: 'todo', note: '（阶段父任务，来自 Excel 阶段列）', isStage: true, parentTitle: '', err: '', warn: '' };
          rows.push(stageParents[stage]);
        }
        rec.parentTitle = stage;
      }
    } else {
      const depth = xwDepthOf(rec.title);
      while (stack.length >= depth) stack.pop();
      rec.parentTitle = stack.length ? stack[stack.length - 1].title : '';
      stack.push(rec);
    }
    rows.push(rec);
  }
  /* 序号/缩进模式：有孩子的行回填为阶段父任务，并修 parentTitle */
  if (!useStage) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].isStage) continue;
      const dNext = i + 1 < rows.length ? xwDepthOf(rows[i + 1].title) : 1;
      if (dNext > xwDepthOf(rows[i].title)) rows[i].isStage = true;
    }
    const stack2 = [];
    rows.forEach(r => {
      const d = xwDepthOf(r.title);
      while (stack2.length >= d) stack2.pop();
      r.parentTitle = stack2.length ? stack2[stack2.length - 1].title : '';
      stack2.push(r);
      if (!r.isStage) stack2.pop();
    });
  }
  return rows;
}
async function xwImport() {
  const built = XW.built || xwBuildImportRows();
  const good = built.filter(r => !r.err);
  if (!good.length) { toast('没有可导入的行', 'err'); return; }
  let pid = 0, pname = '';
  try {
    if (XW.sample) {
      let p = S.projects.find(x => x.name === '示例项目' && !x.archived);
      if (!p) p = await persistProject({ id: 0, name: '示例项目', archived: false, createdAt: TODAY, settingsJson: '{}' });
      pid = p.id; pname = p.name;
    } else if (XW.targetMode === 'new') {
      const nm = ($id('xw-newname') && $id('xw-newname').value.trim()) || XW.newProjName || XW.fileName.replace(/\.[^.]+$/, '');
      const p = await persistProject({ id: 0, name: nm, archived: false, createdAt: TODAY, settingsJson: JSON.stringify({ report: nm + ' 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] }) });
      pid = p.id; pname = p.name;
    } else {
      pid = XW.targetPid || (+($id('xw-targetpid') && $id('xw-targetpid').value) || 0);
      pname = projNameOf(pid);
      if (!pid) { toast('请选择要并入的项目', 'err'); return; }
    }
  } catch (e) { toastErr('准备目标项目失败', e); return; }
  const parentIds = {};
  let ok = 0, skip = 0;
  const skips = [];
  for (const r of good) {
    try {
      let parentId = 0;
      if (r.isStage === false && r.parentTitle) {
        if (parentIds[r.parentTitle] != null) parentId = parentIds[r.parentTitle];
      }
      const base = {
        id: 0, projectId: pid, title: r.title, due: r.due || TODAY, owner: r.owner || '我方',
        pri: r.pri || 'P1', status: r.status === 'done' ? 'done' : r.status === 'doing' ? 'doing' : r.status === 'wait' ? 'wait' : 'todo',
        doneAt: r.status === 'done' ? (r.due || TODAY) : '', risk: false, repeat: '',
        note: r.note || '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]',
        startDate: r.startDate || '', parentId: parentId
      };
      const saved = await persistTask(base);
      if (r.isStage) parentIds[r.title] = saved.id;
      ok++;
    } catch (e) {
      skip++;
      skips.push('第 ' + (r.srcIdx + 1) + ' 行「' + r.title.slice(0, 14) + '」：' + (e && e.message || e));
    }
  }
  /* 父任务修正：persistTask 保存后回填 parentId（同名阶段仅第一个父任务生效） */
  await refreshAll();
  const made = Object.keys(parentIds).length;
  $id('xw-body').innerHTML = '<div class="chips-line"><span class="chip2 good">✅ 成功导入 ' + ok + ' 条到「' + esc(pname) + '」</span>'
    + (made ? '<span class="chip2 cd">📂 阶段父任务 ' + made + ' 个（进度上卷自动生效）</span>' : '')
    + (skip ? '<span class="chip2 bad">跳过 ' + skip + ' 条</span>' : '') + '</div>'
    + (skips.length ? '<div class="xw-preview">' + skips.map(s => '<div class="dn-row">⛔ ' + esc(s) + '</div>').join('') + '</div>' : '')
    + '<div class="hint" style="margin-top:10px;">可在「📊 统计」看交付预测（哪天做完）、「⏱ 时间线」看计划条。</div>';
  $id('xw-import').hidden = true;
  $id('xw-next').hidden = true;
  toast('📥 导入完成：成功 ' + ok + ' 条' + (skip ? '，跳过 ' + skip + ' 条' : ''));
}
function xwMatrixTable(rows, maxRows, headerRow) {
  if (!rows || !rows.length) return '<div class="empty">（空表）</div>';
  const nr = Math.min(rows.length, maxRows + headerRow + 1);
  let h = '<table><tbody>';
  for (let r = 0; r < nr; r++) {
    h += '<tr' + (r === headerRow ? ' class="xw-hr"' : '') + '>';
    for (let c = 0; c < Math.min((rows[r] || []).length, 10); c++) {
      h += '<td>' + esc(String(rows[r][c] || '').slice(0, 16)) + '</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  return h;
}
/* 向导「下一步」：2/3/4 步推进，第 5 步点开始导入 */
function xwNext() {
  if (!XW) return;
  if (XW.step === 2 && XW.sheet) { XW.step = 3; renderExcelWizard(); }
  else if (XW.step === 3) { XW.step = 4; renderExcelWizard(); }
  else if (XW.step === 4) { XW.step = 5; renderExcelWizard(); }
}
/* 简易 CSV 解析（引号/转义/逗号），用于 .csv 文件 */
function parseCsvText(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  text = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}
/* 包5 姊妹功能：导出 .xlsx 计划表（按阶段分组、带样式表头，含状态/风险值/负责人） */
async function exportProjectXlsx() {
  const p = curProject(); if (!p) return;
  let path = null;
  try {
    path = await TDialog().save({
      title: '导出 Excel 计划表',
      defaultPath: p.name + '-计划表-' + TODAY + '.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
  } catch (e) { toastErr('打开保存对话框失败', e); return; }
  if (!path) { toast('已取消导出', 'info'); return; }
  const rows = ganttRows(p.id);
  const stMap = { todo: '待办', doing: '进行中', wait: '等待', done: '已完成' };
  const payload = { sheetName: p.name.slice(0, 28), headers: ['阶段/任务', '负责人', '开始', '截止', '状态', '优先级', '风险', '备注', '完成日期'], widths: [42, 10, 12, 12, 9, 8, 8, 36, 12], rows: [] };
  rows.forEach(r => {
    const t = r.t;
    const d = ganttBarDates(t);
    payload.rows.push({
      group: !!r.isParent,
      cells: [
        (r.depth ? '  '.repeat(r.depth) : '') + t.title,
        t.owner || '我方', t.startDate || d.start, t.due || '',
        (isOverdue(t) ? '已逾期·' : '') + (stMap[t.status] || t.status),
        t.pri || 'P1',
        t.risk ? 'R' + (riskValue(t) || '⚠') : '',
        t.note || '', t.status === 'done' ? (t.doneAt || '') : ''
      ]
    });
  });
  try {
    await invoke('export_xlsx', { path: path, payload: payload });
    toast('📤 已导出带样式计划表：' + path);
  } catch (e) { toastErr('导出 xlsx 失败', e); }
}
/* 从剪贴板建任务（替代后台剪贴板监听的合规方案，见定位边界） */
async function quickAddFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (e) { toast('读取剪贴板失败或无内容', 'err'); return; }
  if (!text.trim()) { toast('剪贴板是空的', 'info'); return; }
  const t = parseQuick(text.split('\n')[0]);
  if (!t.title) { toast('剪贴板内容没解析出标题', 'err'); return; }
  const p = curProject();
  try {
    await persistTask({ id: 0, projectId: p ? p.id : 0, title: t.title, due: t.due, owner: t.owner, pri: t.pri, status: 'todo', doneAt: '', risk: t.risk, repeat: t.repeat, note: '📌 来自剪贴板', createdAt: TODAY, sortOrder: 0, checklistJson: '[]' });
    render();
    toast('📌 已从剪贴板建任务：' + t.title.slice(0, 24));
  } catch (e) { toastErr('建任务失败', e); }
}

/* ============ 每日收尾问答（配合后端通知） ============ */
let shutdownShownDate = '';
async function shutdownCheck() {
  if (!S.shutdownTime) return;
  const now = new Date();
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  if (hm < S.shutdownTime) return;
  if (shutdownShownDate === TODAY) return;
  if (!$id('mw-shutdown').hidden || !$id('mw-confirm').hidden || !$id('mw-prompt').hidden) return;
  try {
    const saved = await getShutdownMeta(TODAY);
    if (saved) { shutdownShownDate = TODAY; return; }
  } catch (e) {}
  shutdownShownDate = TODAY;
  const shut = { done: '', stuck: '', block: '', next3: '' };
  $id('sd-done').value = ''; $id('sd-stuck').value = ''; $id('sd-block').value = ''; $id('sd-next').value = '';
  /* 预填：今天已完成任务作为「干成什么」草稿 */
  const doneToday = S.tasks.filter(t => t.status === 'done' && t.doneAt === TODAY);
  if (doneToday.length) $id('sd-done').value = doneToday.map(t => t.title).join('；');
  $id('sd-date').textContent = TODAY + ' ' + S.shutdownTime;
  openModal('mw-shutdown');
}
/* 包3 #12：站会三问之「阻碍」一键转风险任务（每行一条，进收件箱/当前项目） */
async function shutdownBlockToTask() {
  const raw = $id('sd-block').value.trim();
  if (!raw) { toast('先在「阻碍」里写点什么', 'info'); return; }
  const p = curProject();
  const pid = p ? p.id : 0;
  let n = 0;
  for (const line of raw.split('\n')) {
    const txt = line.replace(/^[-*•\s]+/, '').trim();
    if (!txt) continue;
    try {
      await persistTask({ id: 0, projectId: pid, title: txt.slice(0, 60), due: TODAY, owner: '我方', pri: 'P1', status: 'todo', doneAt: '', risk: true, repeat: '', note: '⛔ 来自收尾问答（阻碍）' + TODAY, createdAt: TODAY, sortOrder: 0, checklistJson: '[]' });
      n++;
    } catch (e) {}
  }
  toast(n ? '🛡 已把 ' + n + ' 条阻碍转成风险任务（计入日报风险栏）' : '没有可转换的阻碍行', n ? 'ok' : 'info');
}
async function saveShutdown() {
  const data = { done: $id('sd-done').value.trim(), stuck: $id('sd-stuck').value.trim(), block: $id('sd-block').value.trim(), next3: $id('sd-next').value.trim() };
  try {
    await invoke('set_meta', { key: 'shutdown_' + TODAY, value: JSON.stringify(data) });
    closeModal('mw-shutdown');
    toast('已记录收尾问答，明天生成日报时自动引用 ✔');
  } catch (e) { toastErr('保存失败', e); }
}
function skipShutdown() { closeModal('mw-shutdown'); }
/* 手动打开收尾问答（命令面板「🌙 收尾问答」入口）：不校验时间与当日是否已弹过，已保存过也可再改 */
async function openShutdownManual() {
  $id('sd-done').value = ''; $id('sd-stuck').value = ''; $id('sd-block').value = ''; $id('sd-next').value = '';
  const doneToday = S.tasks.filter(t => t.status === 'done' && t.doneAt === TODAY);
  if (doneToday.length) $id('sd-done').value = doneToday.map(t => t.title).join('；');
  $id('sd-date').textContent = TODAY + (S.shutdownTime ? ' ' + S.shutdownTime : '');
  openModal('mw-shutdown');
}

/* ============ 设置（自动化规则 #13 + 收尾时间 + AI 模型） ============ */
function stShowSection(sec) {
  document.querySelectorAll('#stTabs button').forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
  document.querySelectorAll('#mw-settings .st-sec').forEach(s => { s.hidden = s.dataset.sec !== sec; });
}
async function openSettings() {
  await loadRules();
  $id('st-overdueTop').checked = !!S.rules.overdueTop;
  $id('st-staleCleanup').checked = !!S.rules.staleCleanup;
  $id('st-doneStopTimer').checked = !!S.rules.doneStopTimer;
  $id('st-inboxNudge').checked = !!S.rules.inboxNudge;
  $id('st-shutdown').value = S.shutdownTime || '';
  try { $id('st-autostart').checked = await invoke('autostart_status'); } catch (e) { $id('st-autostart').checked = false; }
  $id('st-hotkey').value = await invoke('get_meta', { key: 'quickHotkey' }).catch(() => '') || 'Alt+Shift+A';
  $id('st-goal').value = S.dailyGoal || 5;
  try {
    aiProfiles = await loadAiProfiles();
    aiActiveId = await getJsonMeta('aiActiveId', null);
    if (!aiProfiles.some(p => p.id === aiActiveId)) aiActiveId = aiProfiles[0].id;
    aiSelId = aiActiveId;
    aiRenderProfiles();
    aiFillSettings(aiProfiles.find(p => p.id === aiSelId));
  } catch (e) { aiProfiles = []; aiFillSettings({}); }
  aiStatus('');
  stShowSection('general');
  openModal('mw-settings');
}
async function saveSettings() {
  S.rules = {
    overdueTop: $id('st-overdueTop').checked ? 1 : 0,
    staleCleanup: $id('st-staleCleanup').checked ? 1 : 0,
    doneStopTimer: $id('st-doneStopTimer').checked ? 1 : 0,
    inboxNudge: $id('st-inboxNudge').checked ? 1 : 0
  };
  await putJsonMeta('autoRules', S.rules);
  const st = $id('st-shutdown').value.trim();
  S.shutdownTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(st) ? (/^\d:/).test(st) ? '0' + st : st : '';
  await invoke('set_meta', { key: 'shutdownTime', value: S.shutdownTime });
  /* 桌面集成（包2）：自启 / 全局热键 / 今日目标 */
  try {
    const auto = await invoke('autostart_set', { enable: $id('st-autostart').checked });
    if (!auto && $id('st-autostart').checked) toast('开机自启设置未生效（可尝试以管理员运行一次）', 'info');
  } catch (e) { toastErr('设置开机自启失败', e); }
  try {
    const hk = $id('st-hotkey').value.trim() || 'off';
    await invoke('set_quick_hotkey', { hotkey: hk });
    await invoke('set_meta', { key: 'quickHotkey', value: hk === 'off' ? '' : hk });
  } catch (e) { toastErr('设置全局热键失败', e); }
  S.dailyGoal = Math.max(0, +$id('st-goal').value || 5);
  await invoke('set_meta', { key: 'dailyGoal', value: String(S.dailyGoal) });
  if (aiProfiles.length) {
    aiStashFields();
    await putJsonMeta('aiProviders', aiProfiles);
    await putJsonMeta('aiActiveId', aiActiveId);
  }
  closeModal('mw-settings');
  render();
  toast('设置已保存' + (S.shutdownTime ? '，每天 ' + S.shutdownTime + ' 弹收尾三问' : '，收尾问答已关闭'));
}

/* ============ 命令面板（Ctrl+K，跨项目直达） ============ */
let palItems = [], palIdx = 0;
function openPalette() {
  openModal('mw-palette');
  const inp = $id('pal-input');
  inp.value = '';
  renderPalette('');
  setTimeout(() => inp.focus(), 20);
}
function renderPalette(q) {
  q = (q || '').trim().toLowerCase();
  const f = parseFilter(q);
  const kw = f.kw || q;
  palItems = [];
  /* 项目：有关键词时按名称过滤 */
  S.projects.filter(p => !p.archived).forEach(p => {
    if (kw && p.name.toLowerCase().indexOf(kw) < 0) return;
    const n = projTasks(p.id).filter(t => t.status !== 'done').length;
    palItems.push({ kind: 'proj', id: p.id, label: p.name, sub: '项目 · ' + n + ' 项未完成' });
  });
  /* 任务：按关键词过滤；无关键词显示最近要做的 8 条 */
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  let taskList = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0);
  if (kw) taskList = taskList.filter(t => (t.title + ' ' + (t.owner || '') + ' ' + (t.note || '')).toLowerCase().indexOf(kw) >= 0);
  taskList = taskList
    .sort((a, b) => ((a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)) || (a.due < b.due ? -1 : 1))
    .slice(0, kw ? 14 : 8);
  taskList.forEach(t => {
    palItems.push({ kind: 'task', id: t.id, label: t.title, sub: projNameOf(t.projectId) + ' · ' + (t.due || '无日期') + ' · ' + (t.owner || '我方') + (t.status === 'done' ? ' · ✔' : '') });
  });
  /* 决策 / 会议：纳入搜索（包3） */
  S.decisions.forEach(d => {
    if (kw && (d.title + ' ' + (d.decision || '')).toLowerCase().indexOf(kw) < 0) return;
    palItems.push({ kind: 'decision', id: d.id, label: d.title, sub: '决策 · ' + (d.date || '') + ' · ' + projNameOf(d.projectId) });
  });
  S.meetings.forEach(m => {
    if (kw && (m.title + ' ' + (m.attendees || '')).toLowerCase().indexOf(kw) < 0) return;
    palItems.push({ kind: 'meeting', id: m.id, label: m.title, sub: '会议 · ' + (m.date || '') });
  });
  if (!kw) {
    palItems.unshift(
      { kind: 'goto', id: 'today', label: '📅 今日聚焦', sub: '跨项目今日到期 / 逾期 / 进行中' },
      { kind: 'goto', id: 'inbox', label: '📥 收件箱', sub: '分拣无主任务' },
      { kind: 'goto', id: 'ideas', label: '💡 需求池', sub: '想法 / 需求优先级' },
      { kind: 'goto', id: 'trash', label: '🗑 回收站', sub: S.trashCount ? S.trashCount + ' 条可恢复' : '已删除的任务 / 项目' },
      { kind: 'act', id: 'new-task', label: '➕ 新建任务', sub: '快捷键 N；或顶部输入框回车快速添加' },
      { kind: 'act', id: 'shutdown', label: '🌙 每日收尾问答', sub: '今天干成什么 / 卡在哪 / 明天三件事' },
      { kind: 'act', id: 'theme', label: '🌓 切换明暗主题', sub: '当前是' + (S.theme === 'dark' ? '深色' : '浅色') + '主题' },
      { kind: 'act', id: 'settings', label: '⚙ 打开设置', sub: '通用 / 自动化 / 桌面集成 / AI 供应商 / 数据' },
      { kind: 'act', id: 'record-decision', label: '🏛 记录决策', sub: '写入当前项目决策日志（ADR）' },
      { kind: 'act', id: 'clip-task', label: '📌 从剪贴板建任务', sub: '把复制的文字变成任务' },
      { kind: 'act', id: 'excel', label: '📥 Excel 计划表导入', sub: 'Jira 式五步向导' },
      { kind: 'act', id: 'dailynote', label: '📝 打开每日笔记', sub: '今日任务 / 青蛙 / 收尾 / 会议聚合' }
    );
  }
  if (kw) palItems.sort((a, b) => (a.kind === 'proj' ? 1 : 0) - (b.kind === 'proj' ? 1 : 0)); /* 有关键词：任务优先 */
  palIdx = 0;
  $id('pal-list').innerHTML = palItems.length
    ? palItems.map((it, i) =>
        '<div class="pal-item' + (i === 0 ? ' on' : '') + '" data-i="' + i + '" onclick="palPick(' + i + ')">'
        + '<span class="pk">' + (it.kind === 'proj' ? '📂' : it.kind === 'goto' ? '⚡' : it.kind === 'decision' ? '🏛' : it.kind === 'meeting' ? '🗂' : '🛠') + '</span>'
        + '<span class="pl">' + esc(it.label) + '</span>'
        + '<span class="ps">' + esc(it.sub) + '</span></div>').join('')
    : '<div class="empty" style="padding:14px 6px;">没有匹配的项目或任务</div>';
}
function palMark() {
  $id('pal-list').querySelectorAll('.pal-item').forEach(el => {
    el.classList.toggle('on', +el.getAttribute('data-i') === palIdx);
  });
  const on = $id('pal-list').querySelector('.pal-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function palMove(delta) {
  if (!palItems.length) return;
  palIdx = (palIdx + delta + palItems.length) % palItems.length;
  palMark();
}
async function palPick(i) {
  const it = palItems[i];
  if (!it) return;
  closeModal('mw-palette');
  if (it.kind === 'goto') {
    if (it.id === 'today') openTodayFocus();
    else if (it.id === 'inbox') openInbox();
    else if (it.id === 'ideas') openIdeas();
    else if (it.id === 'trash') openTrash();
    else if (it.id === 'dailynote') openDailyNote();
  } else if (it.kind === 'act') {
    if (it.id === 'record-decision') openDecisionModal(0);
    else if (it.id === 'clip-task') quickAddFromClipboard();
    else if (it.id === 'excel') openExcelWizard();
    else if (it.id === 'new-task') openTaskEdit(0);
    else if (it.id === 'shutdown') openShutdownManual();
    else if (it.id === 'theme') toggleTheme();
    else if (it.id === 'settings') openSettings();
  } else if (it.kind === 'decision') {
    const d = S.decisions.find(x => x.id == it.id);
    if (d && d.projectId) await switchProject(d.projectId);
    S.mode = 'project'; S.view = 'decisions';
    render();
  } else if (it.kind === 'meeting') {
    S.mode = 'meetings';
    render();
    setTimeout(() => openMeetingModal(it.id), 30);
  } else if (it.kind === 'proj') {
    await switchProject(it.id);
  } else {
    const t = getTask(it.id);
    if (!t) return;
    S.cur = '' + t.projectId;
    S.mode = 'project';
    try { await invoke('set_meta', { key: 'currentId', value: S.cur }); } catch (e) {}
    render();
    openTaskEdit(t.id);
  }
}

/* ============ 主题 ============ */
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  $id('btnTheme').textContent = S.theme === 'dark' ? '☀️' : '🌙';
}
async function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  try { await invoke('set_meta', { key: 'theme', value: S.theme }); } catch (e) {}
}

/* ============ 事件绑定 ============ */
function bindEvents() {
  $id('btnNewProj').onclick = openNewProject;
  $id('btnTheme').onclick = toggleTheme;
  $id('btnRemind').onclick = askReminderTime;
  $id('btnSettings').onclick = openSettings;
  $id('btnTrash').onclick = openTrash;
  $id('btnAddSmart').onclick = openSaveSmartView;
  $id('btnTodayCopy').onclick = copyTodayList;
  $id('qProj').onchange = e => { S.todayPid = e.target.value; };
  /* 项目工具菜单（⋯） */
  $id('btnProjMore').onclick = e => { e.stopPropagation(); $id('projMenu').hidden = !$id('projMenu').hidden; };
  $id('projMenu').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    $id('projMenu').hidden = true;
    const p = curProject(); if (!p) return;
    const act = btn.dataset.act;
    if (act === 'xlsx') openExcelWizard();
    else if (act === 'xlsx-out') exportProjectXlsx();
    else if (act === 'csv') exportCsv();
    else if (act === 'md') exportProjectMd();
    else if (act === 'settings') openProjectSettings(p.id);
    else if (act === 'tpl') { editingProjectId = p.id; saveProjectAsTemplate(); }
  });
  $id('projName').onclick = () => { const p = curProject(); if (p) openProjectSettings(p.id); };
  $id('btnQuickAdd').onclick = quickAdd;
  $id('quick').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });
  $id('quick').addEventListener('input', quickPreviewRender);
  $id('q-date').onclick = e => { e.stopPropagation(); qTogglePop('date', $id('q-date')); };
  $id('q-owner').onclick = e => { e.stopPropagation(); qTogglePop('owner', $id('q-owner')); };
  $id('q-pri').onclick = e => { e.stopPropagation(); qTogglePop('pri', $id('q-pri')); };
  $id('q-risk').onclick = () => {
    if ($id('quick').value.indexOf('#风险') >= 0) { qRemoveToken(/\s*#风险/g); }
    else qInsert('#风险');
    quickPreviewRender();
  };
  $id('q-inbox').onclick = toggleQInbox;
  $id('q-repeat').onclick = () => {
    /* 点击在 不循环→每日→每周→每月 之间循环 */
    const v = $id('quick').value;
    const cur = /#每周/.test(v) ? '#每周' : /#每月/.test(v) ? '#每月' : (/#(每日|每天)/.test(v) ? '#每日' : '');
    const cycle = ['', '#每日', '#每周', '#每月'];
    qRemoveToken(/\s*#(每日|每天|每周|每月)/g);
    const nextTok = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
    if (nextTok) qInsert(nextTok);
    quickPreviewRender();
  };
  bindKanbanDrag();

  $id('search').addEventListener('input', e => { S.search = e.target.value; renderView(); });

  /* 一级页签：项目下的四个页面 */
  document.querySelectorAll('#pageTabs button').forEach(b => {
    b.onclick = () => switchPage(b.dataset.page);
  });
  /* 二级分段控件：任务页四种呈现 */
  document.querySelectorAll('#viewSeg button').forEach(b => {
    b.onclick = () => switchTab(b.dataset.view);
  });

  $id('m-save').onclick = saveTaskModal;
  $id('m-cancel').onclick = () => closeModal('mw-task');
  $id('m-del').onclick = () => askDelTask(editingTaskId);
  $id('m-cl-add').onclick = clAdd;
  $id('m-cl-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clAdd(); } });
  $id('m-risk').onchange = updateRiskEditor;
  $id('m-prob').onchange = updateRiskEditor;
  $id('m-impact').onchange = updateRiskEditor;

  $id('p-save').onclick = saveProjectModal;
  $id('p-cancel').onclick = () => closeModal('mw-proj');
  $id('p-delete').onclick = deleteProjectFlow;
  $id('p-save-tpl').onclick = saveProjectAsTemplate;
  $id('p-wh-type').onchange = toggleWhSecret;

  $id('np-create').onclick = createProjectFromModal;
  $id('np-cancel').onclick = () => closeModal('mw-newproj');
  $id('np-name').addEventListener('keydown', e => { if (e.key === 'Enter') createProjectFromModal(); });
  $id('np-del-tpl').onclick = deleteTemplateFromModal;

  $id('r-copy').onclick = copyReport;
  $id('r-close').onclick = () => closeModal('mw-report');
  $id('r-wh').onclick = sendReportToGroup;
  $id('r-ai').onclick = aiPolishReport;

  $id('tr-close').onclick = () => closeModal('mw-trash');
  $id('tr-purge-old').onclick = purgeTrashOld;

  $id('sd-save').onclick = saveShutdown;
  $id('sd-skip').onclick = skipShutdown;

  $id('st-save').onclick = saveSettings;
  $id('st-cancel').onclick = () => closeModal('mw-settings');
  /* 设置：五节导航 + 数据节按钮 */
  document.querySelectorAll('#stTabs button').forEach(b => {
    b.onclick = () => stShowSection(b.dataset.sec);
  });
  $id('st-export').onclick = exportBackup;
  $id('st-import').onclick = importBackup;
  $id('st-trash').onclick = openTrash;
  $id('st-backup-now').onclick = async () => {
    try { const path = await invoke('backup_now'); toast(path ? '已备份：' + path : '已备份完成', 'ok'); }
    catch (e) { toastErr('备份失败', e); }
  };
  $id('st-ai-preset').innerHTML = AI_PRESETS.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
  $id('st-ai-preset').onchange = aiPresetChanged;
  $id('st-ai-models').onclick = aiFetchModels;
  $id('st-ai-test').onclick = aiTestConn;
  $id('st-ai-add').onclick = aiAddProfile;
  $id('st-ai-del').onclick = aiDelProfile;
  $id('st-ai-show').onchange = () => { $id('st-ai-key').type = $id('st-ai-show').checked ? 'text' : 'password'; };

  $id('sv-save').onclick = saveSmartViewModal;
  $id('sv-cancel').onclick = () => closeModal('mw-smart');

  $id('cv-ok').onclick = convertIdeaNow;
  $id('cv-cancel').onclick = () => closeModal('mw-convert');

  $id('c-ok').onclick = () => answerConfirm(true);
  $id('c-cancel').onclick = () => answerConfirm(false);

  $id('q-aitask').onclick = openAiTask;
  $id('at-parse').onclick = aiParseTasks;
  $id('at-import').onclick = aiImportParsed;
  $id('at-cancel').onclick = () => closeModal('mw-aitask');
  $id('at-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); aiParseTasks(); }
  });
  $id('m-cl-ai').onclick = aiGenChecklist;
  $id('pr-ok').onclick = () => answerPrompt($id('pr-input').value.trim());
  $id('pr-cancel').onclick = () => answerPrompt(null);
  $id('pr-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') answerPrompt($id('pr-input').value.trim());
  });

  /* ---------- v1.5 新增接线 ---------- */
  /* 决策 */
  $id('d-save').onclick = saveDecisionModal;
  $id('d-cancel').onclick = () => closeModal('mw-decision');
  $id('d-del').onclick = deleteDecisionFlow;
  /* 会议 */
  $id('mt-save').onclick = saveMeetingModal;
  $id('mt-cancel').onclick = () => closeModal('mw-meeting');
  $id('mt-del').onclick = deleteMeetingFlow;
  $id('mt-item-add').onclick = mtItemAdd;
  $id('mt-item-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); mtItemAdd(); } });
  /* 干系人 */
  $id('ct-save').onclick = saveContactModal;
  $id('ct-cancel').onclick = () => closeModal('mw-contact');
  $id('ct-del').onclick = () => { const id = +$id('ct-id').value; if (id) { closeModal('mw-contact'); deleteContactFlow(id); } };
  /* Excel 向导 */
  $id('xw-next').onclick = xwNext;
  $id('xw-import').onclick = xwImport;
  $id('xw-cancel').onclick = () => closeModal('mw-xlsx');
  $id('xw-export').onclick = () => { closeModal('mw-xlsx'); exportProjectXlsx(); };
  /* 专注会话 */
  $id('fc-finish').onclick = focusFinish;
  $id('fc-minimize').onclick = closeFocusOverlay;
  $id('fc-save-note').onclick = saveFocusNote;
  /* 收尾问答：阻碍一键转风险任务 */
  $id('sd-block2task').onclick = shutdownBlockToTask;
  /* 设置：热键试一下 */
  $id('st-hotkey-test').onclick = async () => {
    const hk = $id('st-hotkey').value.trim() || 'off';
    try {
      await invoke('set_quick_hotkey', { hotkey: hk });
      aiStatus('✅ 热键已临时生效：' + (hk === 'off' ? '已关闭' : hk) + '（按底部保存后长期有效）');
    } catch (e) { aiStatus('❌ ' + (e && e.message || e), true); }
  };
  /* [[反链]] 点击代理（全局委托） */
  document.addEventListener('click', handleWikilinkClick);
  /* 计时条专注按钮 */
  const tbFocus = document.querySelector('#timerBar .btn.blue.ghost');
  if (tbFocus) tbFocus.onclick = openFocusOverlay;

  ['mw-task', 'mw-proj', 'mw-report', 'mw-confirm', 'mw-prompt', 'mw-palette', 'mw-newproj', 'mw-trash', 'mw-shutdown', 'mw-settings', 'mw-smart', 'mw-convert', 'mw-aitask', 'mw-decision', 'mw-meeting', 'mw-contact', 'mw-xlsx', 'mw-focus', 'mw-tour'].forEach(wid => {
    $id(wid).addEventListener('mousedown', e => {
      if (e.target === $id(wid)) {
        if (wid === 'mw-confirm') answerConfirm(false);
        else if (wid === 'mw-prompt') answerPrompt(null);
        else if (wid === 'mw-shutdown') skipShutdown();
        else if (wid === 'mw-focus') closeFocusOverlay();
        else if (wid === 'mw-tour') markTourSeen();
        else closeModal(wid);
      }
    });
  });

  /* 命令面板输入 */
  $id('pal-input').addEventListener('input', e => renderPalette(e.target.value));
  $id('pal-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); palPick(palIdx); }
  });

  document.addEventListener('mousedown', e => {
    if (qPopKind && !e.target.closest('#qPop') && !e.target.closest('.q-tools')) hideQPop();
    /* 点击项目工具菜单（⋯）外部时收起菜单 */
    if (!e.target.closest('#projMoreWrap')) $id('projMenu').hidden = true;
    /* 点击任务卡 ⋯ 菜单外部时收起 */
    if (!e.target.closest('.card-menu') && !e.target.closest('.more-btn')) closeCardMenus();
  });

  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.key === 'Escape') {
      if (qPopKind) { hideQPop(); return; }
      if (!$id('projMenu').hidden) { $id('projMenu').hidden = true; return; }
      if (document.querySelector('.card-menu:not([hidden])')) { closeCardMenus(); return; }
      const open = ['mw-prompt', 'mw-confirm', 'mw-palette', 'mw-task', 'mw-proj', 'mw-report', 'mw-newproj', 'mw-trash', 'mw-shutdown', 'mw-settings', 'mw-smart', 'mw-convert', 'mw-aitask', 'mw-decision', 'mw-meeting', 'mw-contact', 'mw-xlsx', 'mw-focus', 'mw-tour'].find(w => !$id(w).hidden);
      if (open === 'mw-prompt') answerPrompt(null);
      else if (open === 'mw-confirm') answerConfirm(false);
      else if (open === 'mw-shutdown') skipShutdown();
      else if (open === 'mw-focus') closeFocusOverlay();
      else if (open === 'mw-tour') markTourSeen();
      else if (open) closeModal(open);
      return;
    }
    /* Ctrl+K / K：命令面板（输入焦点不在输入框时） */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($id('mw-palette').hidden) openPalette(); else closeModal('mw-palette');
      return;
    }
    if (typing) return;
    if (e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault(); $id('search').focus(); $id('search').select();
      return;
    }
    if (e.key === '/') { e.preventDefault(); $id('search').focus(); $id('search').select(); return; }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); openTaskEdit(0); return; }
    if (e.key === '1') switchTab('list');
    if (e.key === '2') switchTab('kanban');
    if (e.key === '3') switchTab('calendar');
    if (e.key === '4') switchTab('timeline');
    if (e.key === '5') switchTab('stats');
    if (e.key === '6') switchTab('decisions');
    if (e.key === '7') switchTab('archive');
  });
}
async function switchTab(v) {
  S.mode = 'project';
  S.view = v;
  try { await invoke('set_meta', { key: 'view', value: v }); } catch (e) {}
  renderHeader();
  renderView();
}
/* 一级页签切换：任务页记住当前呈现，其他页直达 */
async function switchPage(page) {
  if (page === 'task') {
    const tv = ['list', 'kanban', 'calendar', 'timeline'];
    await switchTab(tv.indexOf(S.view) >= 0 ? S.view : 'list');
  } else {
    await switchTab(page);
  }
}

init();
