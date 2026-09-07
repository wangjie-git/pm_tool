/* 任务编辑弹窗、清单编辑、反链 —— 拆分自 ui/app.js（来源行 2031-2180）
 * v2.2：三段分区（基本信息 / 风险登记册 / 清单与备注）、所属项目切换、保存并新建、
 *       单次提醒 remind_at、备注粘贴截图存附件、标题 Enter 保存、备注 Ctrl+Enter 保存 */

import { invoke } from '../backend.js';
import { askConfirm, closeModal, openModal } from '../modal.js';
import { render } from '../render.js';
import { S, TODAY, allDescendantIds, curProject, getTask, parseChecklist, projTasks } from '../state.js';
import { delTaskById, persistTask, switchProject } from '../tasks.js';
import { $id, backlinksOf, esc, mdRender, nowMinStr, toast, toastErr } from '../utils.js';
import { kanbanSuppressClickUntil, listSuppressClickUntil } from '../views/board.js';
import { calSuppressClickUntil } from '../views/calendar.js';

export let editingTaskId = null;

export let editChecklist = [];
export function openTaskEdit(id, prefill) {
  if (Date.now() < kanbanSuppressClickUntil || Date.now() < listSuppressClickUntil || Date.now() < calSuppressClickUntil) return; // 拖拽刚结束，忽略误触点击
  const isNew = !id;
  const t = isNew
    ? Object.assign(
        { id: 0, projectId: quickTargetPid(), title: '', due: TODAY, owner: '我方', pri: 'P1', status: 'todo', doneAt: '', risk: false, repeat: '', note: '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]', deferCount: 0, riskProb: 0, riskImpact: 0, riskMitigate: '', riskEscalate: '', doingSince: '', parentId: 0, startDate: '', isMilestone: false, remindAt: '' },
        prefill || {})
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
  $id('m-remind').value = t.remindAt ? String(t.remindAt).replace(' ', 'T') : '';
  $id('m-note-preview').hidden = true;
  $id('m-note-preview-toggle').textContent = '👁 预览渲染效果';
  /* 所属项目下拉（动线2：编辑时可换项目） */
  const alive = S.projects.filter(x => !x.archived);
  if (isNew && !alive.some(x => x.id == t.projectId) && alive.length) t.projectId = alive[0].id;
  $id('m-proj').innerHTML = alive.map(x =>
    '<option value="' + x.id + '"' + (x.id == t.projectId ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('')
    + (alive.length ? '' : '<option value="0">📥 收件箱</option>');
  fillParentOptions(t.projectId, isNew ? [] : [t.id].concat(allDescendantIds(t.id)), t.parentId);
  $id('m-del').style.display = isNew ? 'none' : '';
  editChecklist = parseChecklist(t).map(x => ({ text: x.text, done: !!x.done }));
  renderChecklistEditor();
  updateClSummary();
  updateRiskEditor();
  /* 分区状态：风险段按勾选展开；清单与备注默认收起（编辑过清单/备注多的任务自动展开省一步） */
  $id('m-sec-risk').open = !!t.risk;
  const hasCl = editChecklist.length > 0 || (t.note || '').length > 0;
  $id('m-sec-cl').open = isNew ? false : !!hasCl;
  renderBacklinks(t);
  openModal('mw-task');
  $id('m-title').focus();
  if (isNew) $id('m-title').select();
}
/* 快速添加目标项目：优先快速添加行的下拉选择；行隐藏时回退当前项目 */
export function quickTargetPid() {
  if (S.qInbox) return 0;
  const row = $id('quickAddRow');
  const sel = $id('qProj');
  if (row && !row.hidden && sel && +sel.value) return +sel.value;
  const p = curProject();
  return p ? p.id : 0;
}
/* 父任务选项跟随所属项目（排除自己与整棵子树，避免成环） */
function fillParentOptions(pid, excludeIds, selectedId) {
  const opts = projTasks(pid).filter(x => (excludeIds || []).indexOf(x.id) < 0 && x.status !== 'done');
  $id('m-parent').innerHTML = '<option value="0">（无父任务）</option>' + opts.map(x =>
    '<option value="' + x.id + '"' + (selectedId == x.id ? ' selected' : '') + '>' + esc(x.title.slice(0, 30)) + '</option>').join('');
}
export function onProjectChange() {
  fillParentOptions(+$id('m-proj').value || 0, editingTaskId ? [editingTaskId].concat(allDescendantIds(editingTaskId)) : [], 0);
}
/* 包4 #14：详情页显示「哪些任务/决策提到过它」 */
export function renderBacklinks(t) {
  if (t.id <= 0) { $id('m-backlinks').hidden = true; return; }
  const links = backlinksOf(t.title);
  const box = $id('m-backlinks');
  if (!links.length) { box.hidden = true; return; }
  box.innerHTML = '<div class="bl-title">🔗 被引用（' + links.length + '）</div>' + links.map(l =>
    '<span class="bl-item" onclick="jumpBacklink(\'' + l.kind + '\',' + l.id + ')">' + esc(l.label) + ' <i>' + esc(l.sub) + '</i></span>').join('');
  box.hidden = false;
}
export function jumpBacklink(kind, id) {
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
export function toggleNotePreview() {
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
export function updateRiskEditor() {
  const on = $id('m-risk').checked;
  $id('m-sec-risk').open = on; /* 勾选 ⚠ 才展开风险登记册（动线2 弹窗分区） */
  const pr = +$id('m-prob').value, im = +$id('m-impact').value;
  const v = (pr > 0 && im > 0) ? pr * im : 0;
  const el = $id('m-risk-val');
  el.textContent = v ? v + '（' + (v >= 15 ? '高危，≥15 自动置顶并强制进日报' : v >= 8 ? '中风险' : '低风险') + '）' : '未评分';
  el.className = 'risk-val' + (v >= 15 ? ' bad' : v >= 8 ? ' warn' : '');
}
/* 清单与备注分区的摘要行：收起时也能看到进度 */
export function updateClSummary() {
  const done = editChecklist.filter(x => x.done).length;
  const note = $id('m-note').value.trim();
  const parts = [];
  if (editChecklist.length) parts.push('清单 ' + done + '/' + editChecklist.length);
  if (note) parts.push('备注 ' + (note.length > 24 ? note.slice(0, 24) + '…' : note));
  $id('m-sec-cl-sum').textContent = parts.length ? '· ' + parts.join(' · ') : '· 空';
}
export async function saveTaskModal(saveAndNew) {
  const title = $id('m-title').value.trim();
  if (!title) { toast('标题不能为空', 'err'); return; }
  const isNew = !editingTaskId;
  const base = isNew
    ? { id: 0, projectId: quickTargetPid(), createdAt: TODAY, sortOrder: 0, doneAt: '', deferCount: 0, doingSince: '' }
    : getTask(editingTaskId);
  if (!isNew && !base) { toast('任务已不存在（可能已被删除）', 'err'); closeModal('mw-task'); return; }
  const ns = $id('m-status').value;
  const remindRaw = $id('m-remind').value ? $id('m-remind').value.replace('T', ' ') : '';
  const t = Object.assign({}, base, {
    title: title,
    due: $id('m-due').value || TODAY,
    startDate: $id('m-start').value || '',
    owner: $id('m-owner').value.trim() || '我方',
    pri: $id('m-pri').value,
    status: ns,
    projectId: +$id('m-proj').value || base.projectId || 0,
    risk: $id('m-risk').checked,
    isMilestone: $id('m-milestone').checked,
    repeat: $id('m-repeat').value,
    note: $id('m-note').value.trim(),
    checklistJson: JSON.stringify(editChecklist),
    remindAt: remindRaw,
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
    const saved = await persistTask(t);
    closeModal('mw-task');
    render();
    toast(isNew ? '已添加' : '已保存');
    if (saveAndNew) {
      openTaskEdit(0, { projectId: saved.projectId, owner: saved.owner, pri: saved.pri, due: saved.due === TODAY ? TODAY : saved.due });
    }
  } catch (e) { toastErr('保存失败', e); }
}
export function renderChecklistEditor() {
  $id('m-cl-items').innerHTML = editChecklist.map((it, i) =>
    '<div class="cl-item ' + (it.done ? 'done' : '') + '">'
    + '<input type="checkbox" ' + (it.done ? 'checked' : '') + ' onchange="clToggle(' + i + ')">'
    + '<span class="cl-text">' + esc(it.text) + '</span>'
    + '<button class="cl-rm" title="删除" onclick="clRemove(' + i + ')">✕</button></div>').join('');
}
export function clToggle(i) { editChecklist[i].done = !editChecklist[i].done; renderChecklistEditor(); updateClSummary(); }
export function clRemove(i) { editChecklist.splice(i, 1); renderChecklistEditor(); updateClSummary(); }
export function clAdd() {
  const v = $id('m-cl-input').value.trim();
  if (!v) return;
  editChecklist.push({ text: v, done: false });
  $id('m-cl-input').value = '';
  renderChecklistEditor();
  updateClSummary();
  $id('m-cl-input').focus();
}
/* 备注 Ctrl+V 粘贴截图（★★★）：图片存 appdata/attachments，备注内联 ![](att:文件名) */
export async function pasteNoteImage(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  let imgItem = null;
  for (const it of items) { if (it.type && it.type.indexOf('image/') === 0) { imgItem = it; break; } }
  if (!imgItem) return; /* 普通文本粘贴走默认行为 */
  e.preventDefault();
  if (!S.attachDir) { toast('附件目录未就绪，请重试', 'err'); return; }
  try {
    const blob = imgItem.getAsFile();
    if (!blob) return;
    const ext = (imgItem.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'png';
    const name = 'att-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.' + ext;
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = () => rej(new Error('读取剪贴板图片失败'));
      fr.readAsDataURL(blob);
    });
    await invoke('save_binary_file', { path: S.attachDir + '\\' + name, dataBase64: b64 });
    const note = $id('m-note');
    const insert = (note.value && !note.value.endsWith('\n') ? '\n' : '') + '![](' + 'att:' + name + ')\n';
    note.value += insert;
    updateClSummary();
    toast('📎 截图已保存为附件并插入备注');
  } catch (err) { toastErr('粘贴图片失败', err); }
}
export function askDelTask(id) {
  const t = getTask(id); if (!t) return;
  askConfirm('删除事项', '确认删除「' + esc(t.title) + '」？删除后进回收站保留 30 天，可随时恢复。', true).then(ok => {
    if (ok) { closeModal('mw-task'); delTaskById(id, true); }
  });
}

/* ============ 项目设置弹窗 ============ */
