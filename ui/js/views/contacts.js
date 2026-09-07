/* 联系人/跟进 —— 拆分自 ui/app.js（来源行 3443-3564） */

import { invoke } from '../backend.js';
import { askConfirm, closeModal, openModal } from '../modal.js';
import { render } from '../render.js';
import { S, TODAY, isOpen } from '../state.js';
import { persistTask } from '../tasks.js';
import { $id, esc, toast, toastErr } from '../utils.js';

export function contactDueDays(c) {
  /* 距下次跟进还剩几天：负数 = 已逾期 N 天；从未沟通过返回 -999（视为最优先跟进） */
  if (!c.lastContact) return -999;
  const fd = (c.followupDays != null && c.followupDays > 0) ? c.followupDays : 14;
  return fd - Math.round((new Date(TODAY) - new Date(c.lastContact)) / 86400000);
}
export function renderContacts() {
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
    const hasLc = !!c.lastContact; /* -999 只出现在从未沟通过：不显示成「逾期 999 天」 */
    const dueChip = !hasLc ? '<span class="chip">🆕 待首次跟进</span>'
      : due > 3 ? '<span class="dim">还有 ' + due + ' 天</span>'
      : due >= 0 ? '<span class="chip due-today">今天该跟进</span>'
      : '<span class="chip due-over">逾期 ' + (-due) + ' 天</span>';
    h += '<tr class="' + (hasLc && due < 0 ? 'bad' : hasLc && due <= 3 ? 'warn' : '') + '">'
      + '<td class="rt">' + esc(c.name) + '</td>'
      + '<td>' + esc(c.org || '—') + '</td>'
      + '<td>' + esc(c.tags || '—') + '</td>'
      + '<td>' + esc(c.projects || '—') + '</td>'
      + '<td>' + esc(c.lastContact || '—') + '</td>'
      + '<td>' + (c.followupDays != null ? c.followupDays : 14) + ' 天</td>'
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
export function openContactModal(id) {
  const c = id ? S.contacts.find(x => x.id == id) : null;
  $id('ct-id').value = c ? c.id : '';
  $id('ct-name').value = c ? c.name : '';
  $id('ct-org').value = c ? c.org : '';
  $id('ct-tags').value = c ? c.tags : '';
  $id('ct-projects').value = c ? c.projects : '';
  $id('ct-last').value = c ? (c.lastContact || TODAY) : TODAY;
  $id('ct-days').value = c ? (c.followupDays != null ? c.followupDays : 14) : 14;
  $id('ct-note').value = c ? c.note : '';
  $id('ct-del').hidden = !c;
  openModal('mw-contact');
  setTimeout(() => $id('ct-name').focus(), 30);
}
let ctSaving = false; /* 防重：双击「保存干系人」只建档一次 */
export async function saveContactModal() {
  if (ctSaving) return;
  ctSaving = true;
  try {
    const name = $id('ct-name').value.trim();
    if (!name) { toast('姓名不能为空', 'err'); return; }
    const fv = +$id('ct-days').value; /* 0/空/NaN 归一：0→1（后端钳制为每天），非法→14 */
    const orig = +$id('ct-id').value ? S.contacts.find(x => x.id == +$id('ct-id').value) : null;
    const c = {
      id: +$id('ct-id').value || 0, name: name, org: $id('ct-org').value.trim(),
      tags: $id('ct-tags').value.trim(), projects: $id('ct-projects').value.trim(),
      note: $id('ct-note').value.trim(), lastContact: $id('ct-last').value || TODAY,
      followupDays: Math.min(365, Math.max(1, Number.isFinite(fv) ? Math.round(fv) : 14)),
      createdAt: orig ? (orig.createdAt || '') : ''
    };
    const saved = await invoke('upsert_contact', { c: c });
    const i = S.contacts.findIndex(x => x.id == saved.id);
    if (i >= 0) S.contacts[i] = saved; else S.contacts.push(saved);
    closeModal('mw-contact');
    render();
    await generateFollowupTasks();
    toast('干系人已保存：' + name);
  } catch (e) { toastErr('保存失败', e); }
  finally { ctSaving = false; }
}
export async function deleteContactFlow(id) {
  const c = S.contacts.find(x => x.id == id); if (!c) return;
  const ok = await askConfirm('删除干系人', '删除「' + esc(c.name) + '」的档案？已生成的跟进任务不受影响。', true);
  if (!ok) return;
  try {
    await invoke('delete_contact', { id: id });
    S.contacts = S.contacts.filter(x => x.id != id);
    render();
  } catch (e) { toastErr('删除失败', e); }
}
export async function logContactInteraction(id) {
  const c = S.contacts.find(x => x.id == id); if (!c) return;
  c.lastContact = TODAY;
  try {
    const saved = await invoke('upsert_contact', { c: c });
    const i = S.contacts.findIndex(x => x.id == saved.id);
    if (i >= 0) S.contacts[i] = saved;
    render();
    toast('已记录今天与「' + c.name + '」的沟通，' + (c.followupDays != null ? c.followupDays : 14) + ' 天后会提醒跟进');
  } catch (e) { toastErr('记录失败', e); }
}
/* 到期干系人 → 自动生成「跟进：某人」任务（幂等：按标记 👤跟进:id 去重） */
export async function generateFollowupTasks() {
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
        note: '干系人跟进 · 周期 ' + (c.followupDays != null ? c.followupDays : 14) + ' 天 · 上次沟通 ' + (c.lastContact || '无记录') + ' ' + marker,
        createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
      });
      created++;
    } catch (e) {}
  }
  if (created) toast('👥 有 ' + created + ' 位干系人到了跟进时间，已生成跟进任务', 'info');
}

/* ============ 包4 #16：每日笔记（复用日报引擎聚合当日信息） ============ */
