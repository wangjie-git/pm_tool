/* 任务/项目数据操作、计时器、回收站、跨天重置 —— 拆分自 ui/app.js（来源行 636-665, 691-922） */

import { getJsonMeta, invoke, putJsonMeta } from './backend.js';
import { askConfirm, closeModal, openModal } from './modal.js';
import { render, renderView } from './render.js';
import { S, STATUS_CYCLE, TODAY, allDescendantIds, curProject, getTask, projTasks, setToday } from './state.js';
import { $id, addDays, addMonths, esc, nowMinStr, pad, toast, toastErr, todayStr } from './utils.js';


/* ---------- 自动化规则（#13，预置开关，非通用引擎） ---------- */
export const RULE_DEFAULTS = { overdueTop: 1, staleCleanup: 1, doneStopTimer: 1, inboxNudge: 1 };
export async function loadRules() {
  S.rules = Object.assign({}, RULE_DEFAULTS, await getJsonMeta('autoRules', {}));
}
export async function loadFrogs() {
  const f = await getJsonMeta('frogs', { date: '', ids: [] });
  if (f.date !== TODAY || !Array.isArray(f.ids)) S.frogs = { date: TODAY, ids: [] };
  else S.frogs = f;
}
export async function saveFrogs() { await putJsonMeta('frogs', S.frogs); }

/* 今日三只青蛙（#7）：最多 3 只 */
export async function toggleFrog(id) {
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

/* 循环任务：完成后下一次到期日 */
export function nextOccurrence(doneAt, rep) {
  if (rep === 'weekly') return addDays(doneAt, 7);
  if (rep === 'monthly') return addMonths(doneAt, 1);
  return TODAY; // daily：第二天重新出现
}
export async function routineReset() {
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
export async function checkDayRollover() {
  const t = todayStr();
  if (t === TODAY) return;
  setToday(t);
  try { await loadFrogs(); } catch (e) {}
  try { await routineReset(); } catch (e) {}
  render();
}

/* ============ 数据操作 ============ */
export async function persistTask(t) {
  const saved = await invoke('upsert_task', { task: t });
  const i = S.tasks.findIndex(x => x.id === saved.id);
  if (i >= 0) S.tasks[i] = saved; else S.tasks.push(saved);
  return saved;
}
export async function persistProject(p) {
  const saved = await invoke('upsert_project', { project: p });
  const i = S.projects.findIndex(x => x.id === saved.id);
  if (i >= 0) S.projects[i] = saved; else S.projects.push(saved);
  return saved;
}
export async function createProject(name) {
  const p = await persistProject({
    id: 0, name: name, archived: false, createdAt: TODAY,
    settingsJson: JSON.stringify({ report: name + ' 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] })
  });
  if (!S.cur) S.cur = '' + p.id;
  return p;
}

export async function switchProject(id) {
  S.cur = '' + id;
  S.mode = 'project';
  S.quickPid = '' + id; /* 快速添加目标项目跟随当前项目，避免加错地方 */
  try { await invoke('set_meta', { key: 'currentId', value: S.cur }); } catch (e) {}
  render();
}

export async function setStatus(id, s) {
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
export async function snoozeTask(id) {
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
export async function togglePin(id) {
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

export async function delTaskById(id, allowUndo) {
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
export async function refreshAll() {
  const data = await invoke('load_app');
  S.projects = data.projects || [];
  S.tasks = data.tasks || [];
  S.ideas = data.ideas || [];
  if (!curProject()) S.cur = '' + (S.projects[0] ? S.projects[0].id : '');
  await refreshTrashCount();
  render();
}

/* ---------- 回收站（#5） ---------- */
export async function refreshTrashCount() {
  try { S.trashCount = ((await invoke('list_deleted')) || []).length; } catch (e) { return; }
  const el = $id('btnTrashCnt');
  if (el) el.textContent = S.trashCount || '';
}
export async function openTrash() {
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
export async function restoreTrash(id) {
  try {
    await invoke('restore_deleted', { id: id });
    closeModal('mw-trash');
    await refreshAll();
    toast('已恢复');
  } catch (e) { toastErr('恢复失败', e); }
}
export async function purgeTrash(id) {
  const ok = await askConfirm('彻底删除', '彻底删除后无法再恢复，继续？', true);
  if (!ok) return;
  try {
    await invoke('purge_deleted', { id: id });
    await openTrash();
    refreshTrashCount();
    toast('已彻底删除');
  } catch (e) { toastErr('操作失败', e); }
}
export async function purgeTrashOld() {
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
export async function toggleTimer(id) {
  try {
    if (S.timer && S.timer.taskId == id) { await stopTimerFlow(false); return; }
    if (S.timer) await stopTimerFlow(true);
    await invoke('start_timer', { taskId: id });
    S.timer = { taskId: id, startedAt: Math.floor(Date.now() / 1000) };
    updateTimerBar();
    render();
  } catch (e) { toastErr('计时失败', e); }
}
export async function stopTimerFlow(silent) {
  try {
    const mins = await invoke('stop_timer');
    S.timer = null;
    updateTimerBar();
    if (!silent) toast(mins > 0 ? '⏱ 已记录 ' + mins + ' 分钟工时' : '计时已停止', mins > 0 ? 'ok' : 'info');
    render();
  } catch (e) { S.timer = null; updateTimerBar(); toastErr('停止计时失败', e); }
}
export function timerText(startedAt) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return pad(h) + ':' + pad(m) + ':' + pad(ss);
}
export function timerTick() {
  if (!S.timer) return;
  const el = $id('timerTime');
  if (el) el.textContent = timerText(S.timer.startedAt);
}
export function updateTimerBar() {
  const bar = $id('timerBar');
  if (!bar) return;
  if (!S.timer) { bar.hidden = true; return; }
  const t = getTask(S.timer.taskId);
  bar.hidden = false;
  $id('timerTaskName').textContent = t ? t.title : '（任务不存在）';
  $id('timerTime').textContent = timerText(S.timer.startedAt);
}

/* ============ v2.2 批量选择与批量操作（动线2：Ctrl/Shift 多选，浮出批量条） ============ */
export function toggleTaskSel(id) {
  const i = S.sel.indexOf(id);
  if (i >= 0) S.sel.splice(i, 1);
  else { S.sel.push(id); S.selAnchor = id; }
  renderView(); renderBatchBar();
}
export function shiftSelectTo(id) {
  const vis = S.visibleIds || [];
  const bi = vis.indexOf(id);
  if (bi < 0) return;
  let ai = S.selAnchor != null ? vis.indexOf(S.selAnchor) : -1;
  if (ai < 0) ai = bi;
  const lo = Math.min(ai, bi), hi = Math.max(ai, bi);
  for (let i = lo; i <= hi; i++) if (S.sel.indexOf(vis[i]) < 0) S.sel.push(vis[i]);
  S.selAnchor = id;
  renderView(); renderBatchBar();
}
export function clearSelection() {
  if (!S.sel.length) return;
  S.sel = []; S.selAnchor = null;
  renderView(); renderBatchBar();
}
function clearSelQuiet() { S.sel = []; S.selAnchor = null; }
export async function batchStatus(s) {
  const ids = S.sel.slice(); if (!ids.length) return;
  for (const id of ids) {
    const t = getTask(id); if (!t) continue;
    t.status = s;
    t.doneAt = (s === 'done') ? TODAY : '';
    if (s === 'doing') { if (!t.doingSince) t.doingSince = nowMinStr(); }
    else if (s === 'done') { t.deferCount = 0; }
    else if (t.doingSince) t.doingSince = '';
    const max = projTasks(t.projectId).reduce((m, x) => Math.max(m, Math.abs(x.sortOrder) || 0), 0);
    t.sortOrder = max + 1;
    try { if (s === 'done' && S.rules.doneStopTimer && S.timer && S.timer.taskId == id) await stopTimerFlow(true); } catch (e) {}
    try { await persistTask(t); } catch (e) { toastErr('批量更新失败', e); }
  }
  clearSelQuiet(); render();
  toast('已批量更新 ' + ids.length + ' 项为「' + (s === 'done' ? '完成' : s === 'doing' ? '进行中' : s) + '」');
}
export async function batchSnoozeSel() {
  const ids = S.sel.slice(); if (!ids.length) return;
  for (const id of ids) {
    const t = getTask(id); if (!t) continue;
    t.due = addDays(TODAY, 1);
    t.deferCount = (t.deferCount || 0) + 1;
    if (t.status === 'wait') t.status = 'todo';
    try { await persistTask(t); } catch (e) { toastErr('批量推迟失败', e); }
  }
  clearSelQuiet(); render();
  toast('已把 ' + ids.length + ' 项推到明天');
}
export async function batchMoveSel() {
  const sel = $id('bbProj');
  if (!sel || !sel.value) { toast('请选择目标项目', 'err'); return; }
  const pid = +sel.value;
  const ids = S.sel.slice(); if (!ids.length) return;
  for (const id of ids) {
    const t = getTask(id); if (!t) continue;
    t.projectId = pid;
    try { await persistTask(t); } catch (e) { toastErr('批量移动失败', e); }
  }
  clearSelQuiet(); render();
  toast('已把 ' + ids.length + ' 项移到「' + (S.projects.find(p => p.id == pid) || {}).name + '」');
}
export async function batchDeleteSel() {
  const ids = S.sel.slice(); if (!ids.length) return;
  const ok = await askConfirm('批量删除', '确认把选中的 <b>' + ids.length + '</b> 项移入回收站？30 天内可恢复。', true);
  if (!ok) return;
  let n = 0;
  for (const id of ids) {
    const t = getTask(id); if (!t) continue;
    const descIds = allDescendantIds(id);
    try {
      await invoke('delete_task', { id: id });
      S.tasks = S.tasks.filter(x => x.id != id && descIds.indexOf(x.id) < 0);
      S.frogs.ids = S.frogs.ids.filter(x => x != id && descIds.indexOf(x) < 0);
      n++;
    } catch (e) { toastErr('删除失败', e); }
  }
  clearSelQuiet();
  refreshTrashCount(); render();
  toast('已删除 ' + n + ' 项（可在回收站恢复）', 'info');
}
/* 批量条跟随选中状态渲染（render() 尾部调用） */
export function renderBatchBar() {
  const bar = $id('batchBar');
  if (!bar) return;
  bar.hidden = !S.sel.length;
  if (!S.sel.length) return;
  $id('bbCount').textContent = '已选 ' + S.sel.length + ' 项';
  const alive = S.projects.filter(p => !p.archived);
  $id('bbProj').innerHTML = alive.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
}

/* ============ v2.2 键盘行导航（动线2：↑↓/J K 移行、空格完成、X 选中；Enter 在 events.js 打开详情） ============ */
export function kbEnsure() {
  if (S.kbId != null && S.visibleIds.indexOf(S.kbId) >= 0) return true;
  S.kbId = S.visibleIds.length ? S.visibleIds[0] : null;
  return S.kbId != null;
}
export function kbMove(delta) {
  if (!kbEnsure()) return;
  const vis = S.visibleIds;
  let i = vis.indexOf(S.kbId);
  if (i < 0) i = 0;
  i = Math.max(0, Math.min(vis.length - 1, i + delta));
  if (vis[i] === S.kbId && delta !== 0) return;
  S.kbId = vis[i];
  document.querySelectorAll('.card.kb-on, .kcard.kb-on').forEach(el => el.classList.remove('kb-on'));
  const el = document.querySelector('.card[data-id="' + S.kbId + '"]');
  if (el) { el.classList.add('kb-on'); el.scrollIntoView({ block: 'nearest' }); }
}
export async function kbToggleDone() {
  if (!kbEnsure()) return;
  const t = getTask(S.kbId); if (!t) return;
  await setStatus(S.kbId, t.status === 'done' ? 'todo' : 'done');
}
/* 紧凑卡状态 chip 点击循环切换（待办→进行中→等待→完成→待办） */
export async function cycleStatus(id, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const t = getTask(id); if (!t) return;
  const i = STATUS_CYCLE.indexOf(t.status);
  const next = STATUS_CYCLE[(i < 0 ? 0 : i + 1) % STATUS_CYCLE.length];
  await setStatus(id, next);
}

