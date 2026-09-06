/* 想法/价值矩阵 —— 拆分自 ui/app.js（来源行 3110-3208） */

import { invoke } from '../backend.js';
import { closeModal, openModal } from '../modal.js';
import { render } from '../render.js';
import { S, TODAY } from '../state.js';
import { persistTask } from '../tasks.js';
import { $id, esc, toast, toastErr } from '../utils.js';

export let editingIdeaId = 0;
export function ideaScore(i2) { return Math.round((i2.value / i2.effort) * 100) / 100; }
export function renderIdeas() {
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
export async function saveIdea() {
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
export function editIdea(id) {
  const i2 = S.ideas.find(x => x.id === id); if (!i2) return;
  editingIdeaId = id;
  render();
  $id('idea-title').value = i2.title;
  $id('idea-v').value = i2.value;
  $id('idea-e').value = i2.effort;
  $id('idea-title').focus();
}
export function cancelIdeaEdit() { editingIdeaId = 0; render(); }
export async function deleteIdea(id) {
  try {
    await invoke('delete_idea', { id: id });
    S.ideas = S.ideas.filter(x => x.id !== id);
    if (editingIdeaId === id) editingIdeaId = 0;
    render();
  } catch (e) { toastErr('删除失败', e); }
}
export function openConvertIdea(id) {
  const alive = S.projects.filter(x => !x.archived);
  if (!alive.length) { toast('先创建一个项目', 'err'); return; }
  $id('cv-idea-id').value = id;
  $id('cv-proj').innerHTML = alive.map(x => '<option value="' + x.id + '">' + esc(x.name) + '</option>').join('');
  $id('cv-due').value = TODAY;
  openModal('mw-convert');
}
export async function convertIdeaNow() {
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
