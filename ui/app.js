/* PM 待办助手 v1.1 —— 前端逻辑
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
      meta: {}, nextId: 100
    };
    localStorage.setItem(KEY, JSON.stringify(db));
  }
  const persist = () => localStorage.setItem(KEY, JSON.stringify(db));
  const clone = x => JSON.parse(JSON.stringify(x));
  return async (cmd, args) => {
    args = args || {};
    switch (cmd) {
      case 'load_app':
        return { projects: clone(db.projects), tasks: clone(db.tasks) };
      case 'upsert_task': {
        const t = clone(args.task);
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
      case 'delete_task':
        db.tasks = db.tasks.filter(x => x.id !== args.id); persist(); return null;
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
      case 'delete_project':
        db.projects = db.projects.filter(x => x.id !== args.id);
        db.tasks = db.tasks.filter(x => x.projectId !== args.id); persist(); return null;
      case 'import_data':
        db.projects = clone(args.data.projects); db.tasks = clone(args.data.tasks); persist(); return null;
      case 'get_meta':
        return (args.key in db.meta) ? db.meta[args.key] : null;
      case 'set_meta':
        db.meta[args.key] = args.value; persist(); return null;
      case 'backup_now':
        return null;
      case 'wechat_list_chats':
        return JSON.stringify([
          { wxid: 'mock1', display: 'HiC2026项目群' },
          { wxid: 'mock2', display: '供应商拉通群' },
          { wxid: 'mock3', display: '客户对接群' }
        ]);
      case 'wechat_read_chat': {
        const d = args.days || 2;
        const base = new Date(); base.setDate(base.getDate() - (d > 2 ? 1 : 0));
        const fmt = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
        const mk = (dayOff, tm, dir, content) => {
          const dt = new Date(); dt.setDate(dt.getDate() - dayOff);
          return { time: fmt(dt) + ' ' + tm, _ts: 0, direction: dir, type: '文本', event: null, content: content, is_text: true, is_system: false };
        };
        return JSON.stringify({ chats: [{ wxid: 'mock', display: 'HiC2026项目群', messages: [
          mk(1, '09:12:00', '[对方]', '麻烦今天下班前把验收方案初稿发我一下'),
          mk(1, '09:30:00', '[我]', '好的，我下午整理'),
          mk(0, '10:02:00', '[对方]', '@张三 闸机联调环境明天能准备好吗'),
          mk(0, '10:05:00', '[对方]', '另外下周三之前需要供应商把茶歇点位图确认掉'),
          mk(0, '10:20:00', '[对方]', '[图片]'),
          mk(0, '11:00:00', '[对方]', '展区人流量预估数据麻烦今天同步一下')
        ] }] });
      }
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
const TODAY = todayStr();
function addDays(s, n) { const p = s.split('-'); const d = new Date(+p[0], +p[1] - 1, +p[2]); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
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

/* ============ 全局状态 ============ */
const S = { projects: [], tasks: [], cur: null, view: 'list', search: '', theme: 'light' };
let editingTaskId = null;
let editingProjectId = null;

function curProject() { return S.projects.find(p => p.id == S.cur) || S.projects[0] || null; }
function projTasks(pid) { return S.tasks.filter(t => t.projectId == pid); }
function getTask(id) { return S.tasks.find(t => t.id == id); }
function parseSettings(p) {
  let s = {};
  try { s = JSON.parse(p.settingsJson || '{}') || {}; } catch (e) { s = {}; }
  if (!Array.isArray(s.milestones) || s.milestones.length !== 3) {
    s.milestones = [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }];
  }
  s.report = s.report || (p.name + ' 进度日报');
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
async function init() {
  try {
    const data = await invoke('load_app');
    S.projects = data.projects || [];
    S.tasks = data.tasks || [];
    if (!S.projects.length) await createProject('示例项目');
    S.cur = await invoke('get_meta', { key: 'currentId' }) || ('' + S.projects[0].id);
    S.view = await invoke('get_meta', { key: 'view' }) || 'list';
    S.theme = await invoke('get_meta', { key: 'theme' }) || 'light';
    if (!curProject()) S.cur = '' + S.projects[0].id;
    applyTheme();
    await routineReset();
    bindEvents();
    render();
  } catch (e) {
    toastErr('加载数据失败', e);
    bindEvents();
  }
}

async function routineReset() {
  const changed = S.tasks.filter(t => t.repeat === 'daily' && t.status === 'done' && t.doneAt !== TODAY);
  for (const t of changed) {
    t.status = 'todo'; t.doneAt = ''; t.due = TODAY;
    try { await persistTask(t); } catch (e) { toastErr('重置每日任务失败', e); }
  }
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
  try { await invoke('set_meta', { key: 'currentId', value: S.cur }); } catch (e) {}
  render();
}

async function setStatus(id, s) {
  const t = getTask(id); if (!t) return;
  t.status = s;
  t.doneAt = (s === 'done') ? TODAY : '';
  const max = projTasks(t.projectId).reduce((m, x) => Math.max(m, Math.abs(x.sortOrder) || 0), 0);
  t.sortOrder = max + 1;
  try { await persistTask(t); render(); } catch (e) { toastErr('更新状态失败', e); }
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
  try {
    await invoke('delete_task', { id: id });
    const idx = S.tasks.findIndex(x => x.id == id);
    S.tasks = S.tasks.filter(x => x.id != id);
    render();
    if (allowUndo) {
      toast('已删除「' + t.title.slice(0, 18) + '」', 'info', {
        label: '撤销',
        onClick: async () => {
          try { await persistTask(t); render(); toast('已恢复'); }
          catch (e) { toastErr('恢复失败', e); }
        }
      });
    } else {
      toast('已删除');
    }
  } catch (e) { toastErr('删除失败', e); }
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
  if (!raw.trim()) { toast('先输入内容，支持「明天 @张三 !P0 #风险」语法', 'info'); return; }
  const t = parseQuick(raw);
  if (!t.title) { toast('没解析出标题：日期/负责人等要写在前、后留出标题文字', 'err'); return; }
  const p = curProject(); if (!p) return;
  try {
    await persistTask({
      id: 0, projectId: p.id, title: t.title, due: t.due, owner: t.owner, pri: t.pri,
      status: 'todo', doneAt: '', risk: t.risk, repeat: t.repeat, note: '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
    });
    $id('quick').value = '';
    const dueLabel = t.due === TODAY ? '今天' : t.due;
    toast('已添加：' + t.title + '（' + dueLabel + ' · ' + t.owner + ' · ' + t.pri + (t.risk ? ' · ⚠风险' : '') + '）');
    render();
  } catch (e) { toastErr('添加失败', e); }
}

/* ============ 搜索与筛选令牌 ============ */
function parseFilter(raw) {
  const f = { kw: '', owner: '', pri: '', risk: false, repeat: false };
  let s = ' ' + raw.trim() + ' ';
  s = s.replace(/@([^\s!#@]+)/g, (m, o) => { f.owner = o; return ' '; });
  s = s.replace(/!(P0|P1|P2)/gi, (m, p) => { f.pri = p.toUpperCase(); return ' '; });
  s = s.replace(/#风险/g, () => { f.risk = true; return ' '; });
  s = s.replace(/#(每日|每天)/g, () => { f.repeat = true; return ' '; });
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
  if (f.repeat) ts = ts.filter(t => t.repeat === 'daily');
  if (f.kw) ts = ts.filter(t => (t.title + ' ' + (t.owner || '') + ' ' + (t.note || '')).toLowerCase().indexOf(f.kw) >= 0);
  return ts;
}
function cmpTask(a, b) {
  const pa = a.sortOrder < 0 ? 0 : 1, pb = b.sortOrder < 0 ? 0 : 1;
  if (pa !== pb) return pa - pb;
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
  const alive = S.projects.filter(p => !p.archived);
  $id('projNav').innerHTML = alive.map(p => {
    const n = projTasks(p.id).filter(t => t.status !== 'done').length;
    return '<div class="proj ' + (p.id == S.cur ? 'on' : '') + '" onclick="switchProject(' + p.id + ')">'
      + '<span class="dot"></span><span class="nm">' + esc(p.name) + '</span>'
      + '<span class="cnt">' + n + '</span>'
      + '<button class="gear" title="项目设置" onclick="event.stopPropagation();openProjectSettings(' + p.id + ')">⚙</button></div>';
  }).join('') || '<div class="empty">暂无项目，点上方 ＋ 新建</div>';

  const arch = S.projects.filter(p => p.archived);
  $id('archWrap').innerHTML = arch.length
    ? '<details><summary>已归档（' + arch.length + '）</summary>' + arch.map(p =>
        '<div class="proj ' + (p.id == S.cur ? 'on' : '') + '" onclick="switchProject(' + p.id + ')">'
        + '<span class="dot"></span><span class="nm">' + esc(p.name) + '</span>'
        + '<button class="gear" title="项目设置" onclick="event.stopPropagation();openProjectSettings(' + p.id + ')">⚙</button></div>').join('') + '</details>'
    : '';
}

function renderHeader() {
  const p = curProject(); if (!p) return;
  $id('projName').textContent = p.name;
  document.querySelectorAll('#viewTabs button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));

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
  $id('statsbar').innerHTML =
    '<span class="chip2 good">本周完成 ' + wkDone + '</span>' +
    (overdue ? '<span class="chip2 bad">逾期 ' + overdue + '</span>' : '') +
    (risks ? '<span class="chip2 warn">风险 ' + risks + '</span>' : '') +
    '<span class="chip2">共 ' + ts.length + ' 项</span>';

  const owners = [];
  ts.forEach(t => { if (t.owner && owners.indexOf(t.owner) < 0) owners.push(t.owner); });
  $id('ownerList').innerHTML = owners.map(o => '<option value="' + esc(o) + '">').join('');
}

function renderView() {
  $id('viewList').hidden = S.view !== 'list';
  $id('viewKanban').hidden = S.view !== 'kanban';
  $id('viewStats').hidden = S.view !== 'stats';
  if (S.view === 'list') renderList();
  else if (S.view === 'kanban') renderKanban();
  else renderStats();
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
function cardHtml(t) {
  const cls = 'card' + (t.risk && t.status !== 'done' ? ' risk' : '') + (t.status === 'wait' ? ' wait' : '')
    + (t.status === 'doing' ? ' doing' : '') + (t.status === 'done' ? ' done' : '') + (t.sortOrder < 0 ? ' pinned' : '');
  const st = [['todo', '待办'], ['doing', '进行中'], ['wait', '等待'], ['done', '完成']];
  const btns = st.map(pp => '<button class="' + (t.status === pp[0] ? 'on' : '') + '" onclick="setStatus(' + t.id + ',\'' + pp[0] + '\')">' + pp[1] + '</button>').join('');
  const cl = checklistSummary(t);
  const clChip = cl ? '<span class="chip clprog">☑ ' + cl.done + '/' + cl.total + '</span>' : '';
  const pinChip = t.sortOrder < 0 ? '<span class="chip pinchip">📌 置顶</span>' : '';
  return '<div class="' + cls + '">'
    + '<button class="ccircle ' + (t.status === 'done' ? 'on' : '') + '" title="点击完成/恢复" onclick="toggleDone(' + t.id + ')"></button>'
    + '<div class="cbody">'
    + '<div class="title" onclick="openTaskEdit(' + t.id + ')">' + esc(t.title) + '</div>'
    + '<div class="meta">' + dueChipHtml(t)
    + '<span class="chip ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : '')) + '">' + esc(t.pri || 'P1') + '</span>'
    + '<span class="chip">👤 ' + esc(t.owner || '我方') + '</span>'
    + (t.risk ? '<span class="chip risk">⚠ 风险</span>' : '')
    + (t.repeat === 'daily' ? '<span class="chip">🔄 每日</span>' : '')
    + clChip + pinChip
    + '</div>'
    + (t.note ? '<div class="note">📝 ' + esc(t.note) + '</div>' : '')
    + '<div class="acts">' + btns
    + '<button onclick="openTaskEdit(' + t.id + ')">✎ 编辑</button>'
    + '<button class="pinbtn ' + (t.sortOrder < 0 ? 'on' : '') + '" title="置顶/取消置顶" onclick="togglePin(' + t.id + ')">📌</button>'
    + '<span class="spacer"></span>'
    + '<button class="del" onclick="delTaskById(' + t.id + ', true)">删除</button></div>'
    + '</div></div>';
}
async function toggleDone(id) {
  const t = getTask(id); if (!t) return;
  await setStatus(id, t.status === 'done' ? 'todo' : 'done');
}
function renderList() {
  const ts = filteredTasks();
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
function renderKanban() {
  const ts = filteredTasks();
  let h = '';
  KANBAN_COLS.forEach(col => {
    const cards = ts.filter(t => t.status === col[0]).sort(cmpTask);
    h += '<div class="kcol" ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="dropTask(event,\'' + col[0] + '\')">'
      + '<div class="khead"><span class="kdot" style="background:' + col[2] + '"></span>' + col[1]
      + '<span class="kcnt">' + cards.length + '</span></div>'
      + (cards.length ? cards.map(t => {
          const cl = checklistSummary(t);
          return '<div class="kcard ' + (t.sortOrder < 0 ? 'pinned' : '') + '" draggable="true" ondragstart="dragTask(event,' + t.id + ')" ondragend="dragEnd(event)" onclick="openTaskEdit(' + t.id + ')">'
          + '<div class="kt">' + (t.sortOrder < 0 ? '📌 ' : '') + esc(t.title) + '</div>'
          + '<div class="km">' + dueChipHtml(t)
          + '<span class="chip ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : '')) + '">' + esc(t.pri || 'P1') + '</span>'
          + '<span class="chip">👤 ' + esc(t.owner || '我方') + '</span>'
          + (t.risk ? '<span class="chip risk">⚠</span>' : '')
          + (t.repeat === 'daily' ? '<span class="chip">🔄</span>' : '')
          + (cl ? '<span class="chip clprog">☑ ' + cl.done + '/' + cl.total + '</span>' : '')
          + '</div></div>';
        }).join('')
        : '<div class="empty">拖拽卡片到这里</div>')
      + '</div>';
  });
  $id('viewKanban').innerHTML = h;
}
function dragTask(e, id) { e.dataTransfer.setData('text/plain', '' + id); e.target.classList.add('dragging'); }
function dragEnd(e) { e.target.classList.remove('dragging'); }
function dragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drop'); }
function dragLeave(e) { e.currentTarget.classList.remove('drop'); }
function dropTask(e, status) {
  e.preventDefault();
  e.currentTarget.classList.remove('drop');
  const id = +e.dataTransfer.getData('text/plain');
  if (id && getTask(id)) setStatus(id, status);
}

/* ---------- 统计视图 ---------- */
function renderStats() {
  const p = curProject(); if (!p) return;
  const ts = projTasks(p.id);
  const open = ts.filter(t => t.status !== 'done');
  const done = ts.filter(t => t.status === 'done');
  const overdue = open.filter(t => t.status !== 'wait' && t.due < TODAY).length;
  const risks = open.filter(t => t.risk).length;
  const wk = addDays(TODAY, -6);
  const wkDone = done.filter(t => t.doneAt && t.doneAt >= wk && t.doneAt <= TODAY).length;
  const rate = ts.length ? Math.round(done.length / ts.length * 100) : 0;

  let h = '<div class="stat-grid">'
    + statCard(ts.length, '总事项', 'c-blue') + statCard(done.length, '已完成', 'c-green')
    + statCard(open.filter(t => t.status === 'doing').length, '进行中', 'c-teal')
    + statCard(overdue, '已逾期', 'c-red') + statCard(risks, '开放风险', 'c-red')
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

  h += '<div class="stat-panel"><h3>🧭 状态分布</h3><div>'
    + '<span class="chip2">📥 待办 ' + open.filter(t => t.status === 'todo').length + '</span>'
    + '<span class="chip2">🔨 进行中 ' + open.filter(t => t.status === 'doing').length + '</span>'
    + '<span class="chip2">⏳ 等待 ' + open.filter(t => t.status === 'wait').length + '</span>'
    + '<span class="chip2 good">✅ 已完成 ' + done.length + '</span>'
    + '</div></div>';

  $id('viewStats').innerHTML = h;
}
function statCard(v, label, color) {
  return '<div class="stat-card ' + color + '"><div class="sv">' + v + '</div><div class="sl">' + label + '</div></div>';
}

/* ============ 任务编辑弹窗（含检查清单） ============ */
let editChecklist = [];
function openTaskEdit(id) {
  const isNew = !id;
  const t = isNew
    ? { id: 0, projectId: curProject().id, title: '', due: TODAY, owner: '我方', pri: 'P1', status: 'todo', doneAt: '', risk: false, repeat: '', note: '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]' }
    : getTask(id);
  if (!t) return;
  editingTaskId = t.id;
  $id('tm-head').textContent = isNew ? '新增事项' : '编辑事项';
  $id('m-title').value = t.title;
  $id('m-due').value = t.due;
  $id('m-owner').value = t.owner || '';
  $id('m-pri').value = t.pri || 'P1';
  $id('m-status').value = t.status;
  $id('m-risk').checked = !!t.risk;
  $id('m-repeat').checked = t.repeat === 'daily';
  $id('m-note').value = t.note || '';
  $id('m-del').style.display = isNew ? 'none' : '';
  editChecklist = parseChecklist(t).map(x => ({ text: x.text, done: !!x.done }));
  renderChecklistEditor();
  openModal('mw-task');
  $id('m-title').focus();
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
async function saveTaskModal() {
  const title = $id('m-title').value.trim();
  if (!title) { toast('标题不能为空', 'err'); return; }
  const isNew = !editingTaskId;
  const base = isNew
    ? { id: 0, projectId: curProject().id, createdAt: TODAY, sortOrder: 0, doneAt: '' }
    : getTask(editingTaskId);
  const ns = $id('m-status').value;
  const t = Object.assign({}, base, {
    title: title,
    due: $id('m-due').value || TODAY,
    owner: $id('m-owner').value.trim() || '我方',
    pri: $id('m-pri').value,
    status: ns,
    risk: $id('m-risk').checked,
    repeat: $id('m-repeat').checked ? 'daily' : '',
    note: $id('m-note').value.trim(),
    checklistJson: JSON.stringify(editChecklist)
  });
  if (ns !== base.status) t.doneAt = (ns === 'done') ? TODAY : '';
  try {
    await persistTask(t);
    closeModal('mw-task');
    render();
    toast(isNew ? '已添加' : '已保存');
  } catch (e) { toastErr('保存失败', e); }
}
function askDelTask(id) {
  const t = getTask(id); if (!t) return;
  askConfirm('删除事项', '确认删除「' + t.title + '」？此操作不可恢复。', true).then(ok => {
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
  openModal('mw-proj');
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
async function deleteProjectFlow() {
  const p = S.projects.find(x => x.id == editingProjectId); if (!p) return;
  const n = projTasks(p.id).length;
  const ok = await askConfirm('删除项目', '确认删除项目「' + p.name + '」及其全部 ' + n + ' 条事项？<b>此操作不可恢复！</b><br><br>建议先在左下角点「备份」导出 JSON。', true);
  if (!ok) return;
  try {
    await invoke('delete_project', { id: p.id });
    S.projects = S.projects.filter(x => x.id != p.id);
    S.tasks = S.tasks.filter(t => t.projectId != p.id);
    const alive = S.projects.filter(x => !x.archived);
    if (!alive.length) {
      const np = await createProject('新项目');
      S.cur = '' + np.id;
    } else if (!curProject() || curProject().archived) {
      S.cur = '' + alive[0].id;
    }
    closeModal('mw-proj');
    render();
    toast('项目已删除');
  } catch (e) { toastErr('删除项目失败', e); }
}

/* ============ 报告 ============ */
function openReport(kind) {
  const p = curProject(); if (!p) return;
  const s = parseSettings(p);
  const ts = projTasks(p.id);
  let out = '';
  if (kind === 'day') {
    const yest = addDays(TODAY, -1);
    const doneL = ts.filter(t => t.status === 'done' && t.doneAt === yest);
    const planL = ts.filter(t => (t.status === 'todo' || t.status === 'doing') && t.due <= TODAY).sort((a, b) => a.due < b.due ? -1 : 1);
    const riskL = ts.filter(t => t.risk && t.status !== 'done');
    out = '【' + s.report + '】' + TODAY + '\n\n一、昨日完成：\n';
    out += doneL.length ? doneL.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n') : '  （无，请补录昨天完成的事项）';
    out += '\n\n二、今日计划：\n';
    out += planL.length ? planL.map(t => '  ▶ ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t)).join('\n') : '  （无）';
    out += '\n\n三、风险与需您决策事项：\n';
    out += riskL.length ? riskL.map(t => '  ⚠ ' + t.title + ' ｜ 状态：' + (t.status === 'wait' ? '等待' + (t.owner || '对方') + '回复' : '推进中') + (t.note ? ' ｜ ' + t.note : '')).join('\n') : '  （无）';
  } else {
    const wkStart = addDays(TODAY, -6), wkEnd = addDays(TODAY, 7);
    const d1 = ts.filter(t => t.status === 'done' && t.doneAt && t.doneAt >= wkStart && t.doneAt <= TODAY);
    const d2 = ts.filter(t => (t.status === 'todo' || t.status === 'doing') && t.due > TODAY && t.due <= wkEnd);
    const d3 = ts.filter(t => t.status !== 'done' && (t.risk || t.status === 'wait'));
    out = '【' + s.report.replace('日报', '周报') + '】' + wkStart + ' ~ ' + TODAY + '\n\n一、本周完成（' + d1.length + ' 项）：\n';
    out += d1.length ? d1.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n') : '  （无）';
    out += '\n\n二、下周计划：\n';
    out += d2.length ? d2.map(t => '  ▶ ' + t.title + '（' + (t.owner || '我方') + '，' + t.due + '）').join('\n') : '  （无）';
    out += '\n\n三、当前风险与阻塞项：\n';
    out += d3.length ? d3.map(t => '  ⚠ ' + t.title + (t.note ? ' ｜ ' + t.note : '')).join('\n') : '  （无）';
  }
  $id('r-title').textContent = kind === 'day' ? '日报预览（发送前补全括号内容）' : '周报预览（发送前核对日期范围）';
  $id('r-area').value = out;
  openModal('mw-report');
}
function clSuffix(t) {
  const cl = checklistSummary(t);
  return cl && cl.total ? '［清单 ' + cl.done + '/' + cl.total + '］' : '';
}
function copyReport() {
  const ta = $id('r-area');
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(ta.value); ok = true; } } catch (e) {}
  if (!ok) { try { ta.select(); ok = document.execCommand('copy'); } catch (e) {} }
  toast(ok ? '已复制，去微信/邮件粘贴即可' : '复制失败，请手动全选复制', ok ? 'ok' : 'err');
}

/* ============ 微信待办导入 ============ */
let wxChats = [];
let wxCurChat = null;
let wxMessages = [];
const WX_TODO_RE = /(麻烦|辛苦|请|尽快|尽快|今天|明天|后天|大后天|周[一二三四五六日天]|月|截止|之前|以前|确认|反馈|验收|联调|上线|部署|修复|跟进|待办|安排|准备|需要|落实|回复|同步|提交|发送|评审|盖章|付款|合同|报价|预算)/;

async function openWechatImport() {
  openModal('mw-wechat');
  $id('wx-due').value = TODAY;
  $id('wx-config').hidden = true;
  $id('wx-main').hidden = false;
  $id('wx-chats').innerHTML = '<div class="wx-loading">正在加载会话列表…</div>';
  $id('wx-msgs').innerHTML = '<div class="empty">左侧选择一个会话后读取消息</div>';
  $id('wx-cur-chat').textContent = '选择左侧会话';
  try {
    const raw = await invoke('wechat_list_chats');
    wxChats = JSON.parse(raw);
    if (!Array.isArray(wxChats)) wxChats = [];
    renderWxChats('');
  } catch (e) {
    wxChats = [];
    $id('wx-chats').innerHTML = '';
    $id('wx-config').hidden = false;
    $id('wx-main').hidden = true;
    $id('wx-python').value = (await invoke('get_meta', { key: 'wechatPython' })) || '';
    $id('wx-dir').value = (await invoke('get_meta', { key: 'wechatDir' })) || '';
  }
}
function renderWxChats(kw) {
  const list = wxChats.filter(c => !kw || (c.display || '').indexOf(kw) >= 0 || (c.wxid || '').indexOf(kw) >= 0);
  $id('wx-chats').innerHTML = list.slice(0, 500).map(c =>
    '<div class="wx-chat ' + (wxCurChat && wxCurChat.display === c.display ? 'on' : '') + '" onclick="pickWxChat(this, ' + JSON.stringify(c.display || c.wxid).replace(/"/g, '&quot;') + ')">'
    + '<span class="nm">' + esc(c.display || c.wxid) + '</span></div>').join('')
    || '<div class="empty">无匹配会话</div>';
}
async function pickWxChat(el, name) {
  wxCurChat = { display: name };
  document.querySelectorAll('.wx-chat').forEach(x => x.classList.remove('on'));
  el.classList.add('on');
  await loadWxMessages();
}
async function loadWxMessages() {
  if (!wxCurChat) return;
  const days = +$id('wx-days').value || 2;
  $id('wx-msgs').innerHTML = '<div class="wx-loading">正在读取「' + esc(wxCurChat.display) + '」最近 ' + days + ' 天消息…（大群可能需要十几秒）</div>';
  $id('wx-cur-chat').textContent = wxCurChat.display;
  try {
    const raw = await invoke('wechat_read_chat', { contact: wxCurChat.display, days: days });
    const data = JSON.parse(raw);
    wxMessages = [];
    (data.chats || []).forEach(c => (c.messages || []).forEach(m => wxMessages.push(m)));
    wxMessages.sort((a, b) => (a.time || '') < (b.time || '') ? -1 : 1);
    renderWxMessages();
  } catch (e) {
    $id('wx-msgs').innerHTML = '<div class="empty">读取失败：' + esc(e && e.message || e) + '</div>';
  }
}
function isWxTodo(m) {
  return m.is_text && !m.is_system && m.content && WX_TODO_RE.test(m.content);
}
function renderWxMessages() {
  if (!wxMessages.length) {
    $id('wx-msgs').innerHTML = '<div class="empty">该时间段没有消息</div>';
    updateWxCount();
    return;
  }
  const smart = $id('wx-smart').checked;
  $id('wx-msgs').innerHTML = wxMessages.map((m, i) => {
    const sys = m.is_system || !m.is_text;
    const sel = !sys && document.getElementById('wxm-' + i) ? document.getElementById('wxm-' + i).checked : (smart && isWxTodo(m));
    return '<div class="wx-msg ' + (sys ? 'sys' : '') + ' ' + (sel ? 'sel' : '') + '" onclick="toggleWxMsg(' + i + ')">'
      + '<input type="checkbox" id="wxm-' + i + '" ' + (sel ? 'checked' : '') + ' ' + (sys ? 'disabled' : '') + ' onclick="event.stopPropagation()">'
      + '<div class="m-body">'
      + '<div class="m-meta"><span class="who ' + (m.direction === '[我]' ? 'me' : '') + '">' + esc(m.direction || '') + '</span> ' + esc(m.time || '') + (isWxTodo(m) && !sys ? '<span class="m-todo">疑似待办</span>' : '') + '</div>'
      + '<div class="m-content">' + (m.is_text ? esc(m.content || '') : '[' + esc(m.type || '非文本') + ']') + '</div>'
      + '</div></div>';
  }).join('');
  updateWxCount();
}
function toggleWxMsg(i) {
  if (wxMessages[i].is_system || !wxMessages[i].is_text) return;
  const cb = document.getElementById('wxm-' + i);
  cb.checked = !cb.checked;
  cb.closest('.wx-msg').classList.toggle('sel', cb.checked);
  updateWxCount();
}
function updateWxCount() {
  let n = 0;
  wxMessages.forEach((m, i) => {
    const cb = document.getElementById('wxm-' + i);
    if (cb && cb.checked) n++;
  });
  $id('wx-count').textContent = '已选 ' + n + ' 条';
  $id('wx-convert').textContent = '转为任务（' + n + '）';
}
function msgDateHint(content) {
  const rel = { '今天': 0, '明天': 1, '后天': 2, '大后天': 3 };
  const m1 = content.match(/(大后天|后天|明天|今天)/);
  if (m1) return addDays(TODAY, rel[m1[1]]);
  const m2 = content.match(/(下周|本周|)?周([一二三四五六日天])/);
  if (m2) {
    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    const target = map[m2[2]];
    const curDow = new Date().getDay() || 7;
    let delta = m2[1] === '下周' ? (8 - curDow) + (target - 1) : (target - curDow);
    if (delta <= 0) delta += 7;
    return addDays(TODAY, delta);
  }
  const m3 = content.match(/(\d{1,2})月(\d{1,2})日/);
  if (m3) {
    const y = new Date().getFullYear();
    const d = y + '-' + pad(+m3[1]) + '-' + pad(+m3[2]);
    return d < TODAY ? (y + 1) + '-' + pad(+m3[1]) + '-' + pad(+m3[2]) : d;
  }
  return null;
}
async function convertWxMessages() {
  const p = curProject(); if (!p) return;
  const defaultOwner = $id('wx-owner').value.trim() || '我方';
  const fallbackDue = $id('wx-due').value || TODAY;
  const selected = [];
  wxMessages.forEach((m, i) => {
    const cb = document.getElementById('wxm-' + i);
    if (cb && cb.checked) selected.push(m);
  });
  if (!selected.length) { toast('先勾选要转换的消息', 'err'); return; }
  try {
    for (const m of selected) {
      let content = (m.content || '').trim();
      const mention = content.match(/@([^\s@,:，。]+)/);
      const owner = mention ? mention[1].replace(/\d{5,}$/, '') : defaultOwner;
      const due = msgDateHint(content) || fallbackDue;
      let title = content.replace(/@[^\s@,:，。]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (title.length > 60) title = title.slice(0, 60) + '…';
      if (!title) title = '[图片/非文本] ' + (m.time || '');
      const note = '来自微信「' + (wxCurChat ? wxCurChat.display : '') + '」' + (m.time || '') + '\n原文：' + content;
      await persistTask({
        id: 0, projectId: p.id, title: title, due: due, owner: owner, pri: 'P1',
        status: 'todo', doneAt: '', risk: false, repeat: '', note: note, createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
      });
    }
    closeModal('mw-wechat');
    render();
    toast('已从微信导入 ' + selected.length + ' 条任务', 'ok');
  } catch (e) { toastErr('导入失败', e); }
}
async function saveWxCfg() {
  try {
    await invoke('set_meta', { key: 'wechatPython', value: $id('wx-python').value.trim() });
    await invoke('set_meta', { key: 'wechatDir', value: $id('wx-dir').value.trim() });
    $id('wx-config').hidden = true;
    $id('wx-main').hidden = false;
    openWechatImport();
  } catch (e) { toastErr('保存配置失败', e); }
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
  const data = { v: 3, exportedAt: TODAY, projects: S.projects, tasks: S.tasks };
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
    checklistJson: typeof t.checklistJson === 'string' ? t.checklistJson : '[]'
  }));
  try {
    await invoke('import_data', { data: { projects: d.projects, tasks: d.tasks } });
    S.projects = d.projects; S.tasks = d.tasks;
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
  const rows = [['标题', '截止日期', '负责人', '优先级', '状态', '风险', '每日循环', '检查清单', '备注', '完成日期', '创建日期']];
  projTasks(p.id).slice().sort(cmpTask).forEach(t => {
    const cl = checklistSummary(t);
    rows.push([t.title, t.due, t.owner || '我方', t.pri || 'P1', stMap[t.status] || t.status,
      t.risk ? '是' : '', t.repeat === 'daily' ? '是' : '',
      cl ? cl.done + '/' + cl.total : '', t.note, t.doneAt, t.createdAt]);
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
  $id('btnExport').onclick = exportBackup;
  $id('btnImport').onclick = importBackup;
  $id('btnCsv').onclick = exportCsv;
  $id('btnWechat').onclick = openWechatImport;
  $id('projName').onclick = () => { const p = curProject(); if (p) openProjectSettings(p.id); };
  $id('btnHelp').onclick = () => { const h = $id('helpBox'); h.hidden = !h.hidden; };
  $id('btnQuickAdd').onclick = quickAdd;
  $id('quick').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });

  $id('search').addEventListener('input', e => { S.search = e.target.value; renderView(); });

  document.querySelectorAll('#viewTabs button').forEach(b => {
    b.onclick = async () => {
      S.view = b.dataset.view;
      try { await invoke('set_meta', { key: 'view', value: S.view }); } catch (e) {}
      renderView();
      document.querySelectorAll('#viewTabs button').forEach(x => x.classList.toggle('on', x.dataset.view === S.view));
    };
  });

  $id('m-save').onclick = saveTaskModal;
  $id('m-cancel').onclick = () => closeModal('mw-task');
  $id('m-del').onclick = () => askDelTask(editingTaskId);
  $id('m-cl-add').onclick = clAdd;
  $id('m-cl-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clAdd(); } });

  $id('p-save').onclick = saveProjectModal;
  $id('p-cancel').onclick = () => closeModal('mw-proj');
  $id('p-delete').onclick = deleteProjectFlow;

  $id('r-copy').onclick = copyReport;
  $id('r-close').onclick = () => closeModal('mw-report');

  $id('wx-chat-filter').addEventListener('input', e => renderWxChats(e.target.value.trim()));
  $id('wx-load').onclick = loadWxMessages;
  $id('wx-smart').onchange = renderWxMessages;
  $id('wx-convert').onclick = convertWxMessages;
  $id('wx-close').onclick = () => closeModal('mw-wechat');
  $id('wx-save-cfg').onclick = saveWxCfg;

  $id('c-ok').onclick = () => answerConfirm(true);
  $id('c-cancel').onclick = () => answerConfirm(false);
  $id('pr-ok').onclick = () => answerPrompt($id('pr-input').value.trim());
  $id('pr-cancel').onclick = () => answerPrompt(null);
  $id('pr-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') answerPrompt($id('pr-input').value.trim());
  });

  ['mw-task', 'mw-proj', 'mw-report', 'mw-wechat', 'mw-confirm', 'mw-prompt'].forEach(wid => {
    $id(wid).addEventListener('mousedown', e => {
      if (e.target === $id(wid)) {
        if (wid === 'mw-confirm') answerConfirm(false);
        else if (wid === 'mw-prompt') answerPrompt(null);
        else closeModal(wid);
      }
    });
  });

  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.key === 'Escape') {
      const open = ['mw-prompt', 'mw-confirm', 'mw-task', 'mw-proj', 'mw-report', 'mw-wechat'].find(w => !$id(w).hidden);
      if (open === 'mw-prompt') answerPrompt(null);
      else if (open === 'mw-confirm') answerConfirm(false);
      else if (open) closeModal(open);
      return;
    }
    if (typing) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault(); $id('search').focus(); $id('search').select();
      return;
    }
    if (e.key === '/') { e.preventDefault(); $id('search').focus(); $id('search').select(); return; }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); openTaskEdit(0); return; }
    if (e.key === '1') switchTab('list');
    if (e.key === '2') switchTab('kanban');
    if (e.key === '3') switchTab('stats');
  });
}
async function switchTab(v) {
  S.view = v;
  try { await invoke('set_meta', { key: 'view', value: v }); } catch (e) {}
  renderView();
  document.querySelectorAll('#viewTabs button').forEach(x => x.classList.toggle('on', x.dataset.view === S.view));
}

init();
