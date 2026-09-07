/* mock 后端、invoke 封装、meta 读写 —— 拆分自 ui/app.js（来源行 8-236, 525-536） */

import { nowMinStr, todayStr } from './utils.js';

export function makeMockBackend() {
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
        return { projects: clone(db.projects), tasks: clone(db.tasks), ideas: clone(db.ideas), timeLogs: clone(db.timeLogs),
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
        /* 与桌面版一致：递归收集全部子孙任务一并入回收站，避免预览模式下子任务变孤儿 */
        const all = [args.id];
        for (let i = 0; i < all.length; i++) {
          db.tasks.filter(x => x.parentId === all[i] && !all.includes(x.id)).forEach(x => all.push(x.id));
        }
        let trashId = 0;
        all.forEach(tid => {
          const t = db.tasks.find(x => x.id === tid);
          if (!t) return;
          const tid2 = db.trashNext++;
          db.trash.push({ id: tid2, kind: 'task', payload: clone(t), summary: t.title, deletedAt: nowMinStr() });
          if (tid === args.id) trashId = tid2;
        });
        db.tasks = db.tasks.filter(x => !all.includes(x.id));
        if (all.includes(+db.meta.timerTaskId)) { delete db.meta.timerTaskId; delete db.meta.timerStart; }
        persist(); return trashId;
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
        db.tasks = db.tasks.filter(x => x.projectId !== args.id);
        if (pts.some(x => x.id === +db.meta.timerTaskId)) { delete db.meta.timerTaskId; delete db.meta.timerStart; }
        persist(); return trashId;
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
        else {
          /* 与桌面版一致：只清 30 天前的条目，而非整个回收站 */
          const p2 = n => (n < 10 ? '0' + n : '' + n);
          const c = new Date(Date.now() - 30 * 86400000);
          const cut = c.getFullYear() + '-' + p2(c.getMonth() + 1) + '-' + p2(c.getDate()) + ' ' + p2(c.getHours()) + ':' + p2(c.getMinutes());
          db.trash = db.trash.filter(x => (x.deletedAt || '') >= cut);
        }
        persist(); return null;
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
        db.ideas = clone(args.data.ideas || []);
        delete db.meta.timerTaskId; delete db.meta.timerStart;
        persist(); return null;
      case 'list_decisions':
        return clone(args.projectId ? db.decisions.filter(d => d.projectId == args.projectId) : db.decisions);
      case 'upsert_decision': {
        const d = clone(args.d);
        if (!d.status) d.status = '生效中';
        if (!d.date) d.date = T;
        if (d.id > 0) {
          const i = db.decisions.findIndex(x => x.id === d.id);
          if (i >= 0) {
            if (!d.createdAt && db.decisions[i].createdAt) d.createdAt = db.decisions[i].createdAt;
            db.decisions[i] = d;
          }
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
          if (i >= 0) {
            if (!m.createdAt && db.meetings[i].createdAt) m.createdAt = db.meetings[i].createdAt;
            db.meetings[i] = m;
          }
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
          if (i >= 0) {
            if (!c.createdAt && db.contacts[i].createdAt) c.createdAt = db.contacts[i].createdAt;
            db.contacts[i] = c;
          }
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
    dialog: { save: async () => null, open: async () => null },
    _isMock: true
  };
}
export const invoke = window.__TAURI__.core.invoke;
export const TDialog = () => window.__TAURI__.dialog;

/* ============ 初始化 ============ */
export async function getJsonMeta(key, fallback) {
  try {
    const v = await invoke('get_meta', { key: key });
    if (v == null) return fallback; /* 只有没存过才算缺失：'0'/'false'/空串 都是合法存储值 */
    const p = JSON.parse(v);
    return p == null ? fallback : p;
  } catch (e) { return fallback; }
}
export async function putJsonMeta(key, val) {
  await invoke('set_meta', { key: key, value: JSON.stringify(val) });
}
