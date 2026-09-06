/* 决策记录 —— 拆分自 ui/app.js（来源行 3209-3289） */

import { invoke } from '../backend.js';
import { askConfirm, closeModal, openModal } from '../modal.js';
import { render } from '../render.js';
import { S, TODAY, curProject, projTasks } from '../state.js';
import { $id, backlinksOf, esc, toast, toastErr } from '../utils.js';

export function renderDecisions() {
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
export function openDecisionModal(id) {
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
export async function saveDecisionModal() {
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
export async function deleteDecisionFlow() {
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
