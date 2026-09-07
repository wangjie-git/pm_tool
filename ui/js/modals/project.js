/* 项目设置弹窗、模板、删除项目 —— 拆分自 ui/app.js（来源行 2181-2268） */

import { getJsonMeta, invoke, putJsonMeta } from '../backend.js';
import { askConfirm, askPrompt, closeModal, openModal } from '../modal.js';
import { render } from '../render.js';
import { S, curProject, getTask, parseSettings, projTasks } from '../state.js';
import { createProject, persistProject, refreshTrashCount, switchProject, updateTimerBar } from '../tasks.js';
import { $id, esc, toast, toastErr } from '../utils.js';

export let editingProjectId = null;

export function openProjectSettings(id) {
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
export function toggleWhSecret() {
  $id('p-wh-secret-row').hidden = $id('p-wh-type').value !== 'dingtalk';
}
export async function saveProjectModal() {
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
export async function saveProjectAsTemplate() {
  const p = S.projects.find(x => x.id == editingProjectId); if (!p) return;
  const name = await askPrompt('另存为项目模板', '模板名称：', p.name + '模板');
  if (!name || !name.trim()) return;
  try {
    const tplTasks = projTasks(p.id).filter(t => t.status !== 'done').map(t => ({
      title: t.title, note: t.note, pri: t.pri, owner: t.owner, repeat: t.repeat || '', checklistJson: t.checklistJson || '[]'
    }));
    const tpls = await getJsonMeta('templates', []);
    tpls.push({ id: Date.now(), name: name.trim(), tasks: tplTasks });
    await putJsonMeta('templates', tpls);
    toast('已保存模板「' + name.trim() + '」（' + tplTasks.length + ' 条任务骨架），新建项目时可选用');
  } catch (e) { toastErr('保存模板失败', e); }
}
/* events.js 项目工具菜单入口：editingProjectId 只能由本模块赋值（导入绑定只读） */
export function saveProjectAsTemplateOf(pid) { editingProjectId = pid; return saveProjectAsTemplate(); }
export async function deleteProjectFlow() {
  const p = S.projects.find(x => x.id == editingProjectId); if (!p) return;
  const n = projTasks(p.id).length;
  const ok = await askConfirm('删除项目', '确认删除项目「' + esc(p.name) + '」及其全部 ' + n + ' 条事项？<br><b>项目将进入回收站，30 天内可恢复。</b><br><br>也可先在左下角点「备份」导出 JSON。', true);
  if (!ok) return;
  try {
    await invoke('delete_project', { id: p.id });
    S.projects = S.projects.filter(x => x.id != p.id);
    S.tasks = S.tasks.filter(t => t.projectId != p.id);
    /* 计时中的任务随项目删除时，先收掉计时条，避免继续为不存在的任务计时/写工时 */
    if (S.timer && !getTask(S.timer.taskId)) {
      S.timer = null;
      updateTimerBar();
      invoke('stop_timer').catch(() => {});
    }
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
