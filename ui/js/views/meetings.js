/* 会议纪要→任务/决策 —— 拆分自 ui/app.js（来源行 3290-3442） */

import { invoke } from '../backend.js';
import { askConfirm, closeModal, openModal } from '../modal.js';
import { render } from '../render.js';
import { S, TODAY, curProject, getTask, projNameOf } from '../state.js';
import { persistTask } from '../tasks.js';
import { $id, esc, mdRender, toast, toastErr } from '../utils.js';

export function parseMeetingItems(json) {
  try {
    const arr = JSON.parse(json || '[]');
    if (Array.isArray(arr)) return arr.filter(x => x && typeof x.text === 'string');
  } catch (e) {}
  return [];
}
export function renderMeetings() {
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
export function openMeetingModal(id) {
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
export function renderMeetingItemEditor() {
  $id('mt-items').innerHTML = (window._mtItems || []).map((it, i) =>
    '<div class="cl-item"><span class="cl-text">' + esc(it.text) + '</span>'
    + '<button class="cl-rm" title="删除" onclick="mtItemRemove(' + i + ')">✕</button></div>').join('');
}
export function mtItemAdd() {
  const v = $id('mt-item-input').value.trim();
  if (!v) return;
  window._mtItems.push({ text: v, taskId: 0, decisionId: 0 });
  $id('mt-item-input').value = '';
  renderMeetingItemEditor();
  $id('mt-item-input').focus();
}
export function mtItemRemove(i) { window._mtItems.splice(i, 1); renderMeetingItemEditor(); }
let mtSaving = false; /* 防重：双击保存/转任务/记决策只执行一轮 */
export async function saveMeetingModal() {
  if (mtSaving) return;
  mtSaving = true;
  try {
    const title = $id('mt-title').value.trim();
    if (!title) { toast('议题不能为空', 'err'); return; }
    const orig = +$id('mt-id').value ? S.meetings.find(x => x.id == +$id('mt-id').value) : null;
    const m = {
      id: +$id('mt-id').value || 0, date: $id('mt-date').value || TODAY, title: title,
      attendees: $id('mt-attendees').value.trim(), conclusion: $id('mt-conclusion').value.trim(),
      projectId: +$id('mt-proj').value || 0, itemsJson: JSON.stringify(window._mtItems || []),
      createdAt: orig ? (orig.createdAt || '') : ''
    };
    const saved = await invoke('upsert_meeting', { m: m });
    const i = S.meetings.findIndex(x => x.id == saved.id);
    if (i >= 0) S.meetings[i] = saved; else S.meetings.unshift(saved);
    closeModal('mw-meeting');
    render();
    toast('会议纪要已保存');
  } catch (e) { toastErr('保存会议失败', e); }
  finally { mtSaving = false; }
}
export async function deleteMeetingFlow() {
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
export async function meetingItemToTask(meetingId, idx) {
  if (mtSaving) return;
  mtSaving = true;
  try {
    const m = S.meetings.find(x => x.id == meetingId); if (!m) return;
    const items = parseMeetingItems(m.itemsJson);
    const it = items[idx]; if (!it) return;
    const pid = m.projectId || (curProject() ? curProject().id : 0);
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
  finally { mtSaving = false; }
}
/* 行动项 → 决策日志：预填背景=会议结论，日期=会议日期 */
export async function meetingItemToDecision(meetingId, idx) {
  if (mtSaving) return;
  mtSaving = true;
  try {
    const m = S.meetings.find(x => x.id == meetingId); if (!m) return;
    const items = parseMeetingItems(m.itemsJson);
    const it = items[idx]; if (!it) return;
    const d = {
      id: 0, projectId: m.projectId || (curProject() ? curProject().id : 0), title: it.text,
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
  finally { mtSaving = false; }
}

/* ============ 包3 #11：干系人跟进（FollowUpThen 机制） ============ */
