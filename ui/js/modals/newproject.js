/* 新建项目（模板选择） —— 拆分自 ui/app.js（来源行 2949-2999） */

import { getJsonMeta, invoke, putJsonMeta } from '../backend.js';
import { askConfirm, closeModal, openModal } from '../modal.js';
import { render } from '../render.js';
import { S, TODAY } from '../state.js';
import { persistProject, persistTask } from '../tasks.js';
import { $id, esc, toast } from '../utils.js';

/* ============ 新建项目（支持项目模板 #4） ============ */
export async function openNewProject() {
  const tpls = await getJsonMeta('templates', []);
  $id('np-name').value = '';
  $id('np-tpl').innerHTML = '<option value="">（空白项目）</option>' + tpls.map(t =>
    '<option value="' + t.id + '">' + esc(t.name) + '（' + (t.tasks || []).length + ' 条骨架）</option>').join('');
  openModal('mw-newproj');
  setTimeout(() => { $id('np-name').focus(); }, 30);
}
let creating = false; /* 防重：回车 + 点击 / 双击只创建一个项目，模板任务也只复制一轮 */
export async function createProjectFromModal() {
  if (creating) return;
  const name = $id('np-name').value.trim();
  if (!name) { toast('项目名称不能为空', 'err'); return; }
  creating = true;
  const btn = $id('np-create');
  if (btn) btn.disabled = true;
  try {
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
  } catch (e) { toastErr('创建项目失败', e); }
  finally {
    creating = false;
    if (btn) btn.disabled = false;
  }
}
export async function deleteTemplateFromModal() {
  const tplId = +$id('np-tpl').value || 0;
  if (!tplId) { toast('选择要删除的模板', 'info'); return; }
  const tpls = await getJsonMeta('templates', []);
  const tpl = tpls.find(t => t.id === tplId);
  if (!tpl) return;
  const ok = await askConfirm('删除模板', '删除模板「' + esc(tpl.name) + '」？不影响已有项目。', true);
  if (!ok) return;
  await putJsonMeta('templates', tpls.filter(t => t.id !== tplId));
  const keepName = $id('np-name').value; /* 重开列表但保留用户已输入的项目名，避免白打一遍 */
  await openNewProject();
  $id('np-name').value = keepName;
  toast('模板已删除');
}

/* ============ 收件箱分拣（#12） ============ */
