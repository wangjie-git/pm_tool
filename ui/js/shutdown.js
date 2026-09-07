/* 每日收尾问答 —— 拆分自 ui/app.js（来源行 4519-4575） */

import { invoke } from './backend.js';
import { closeModal, openModal } from './modal.js';
import { getShutdownMeta } from './report.js';
import { S, TODAY, curProject } from './state.js';
import { persistTask } from './tasks.js';
import { $id, pad, toast, toastErr } from './utils.js';


/* ============ 每日收尾问答（配合后端通知） ============ */
export let shutdownShownDate = '';
export async function shutdownCheck() {
  if (!S.shutdownTime) return;
  const now = new Date();
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  if (hm < S.shutdownTime) return;
  if (shutdownShownDate === TODAY) return;
  /* 任意弹窗打开时不叠加：点蒙层会误关收尾问答、被上层弹窗遮盖时用户完全看不到 */
  if (document.querySelector('.mwrap:not([hidden])')) return;
  try {
    const saved = await getShutdownMeta(TODAY);
    if (saved) { shutdownShownDate = TODAY; return; }
  } catch (e) {}
  /* await 期间用户可能打开了其他弹窗（设置/面板等）：再查一次，避免收尾问答叠加上去 */
  if (document.querySelector('.mwrap:not([hidden])')) return;
  shutdownShownDate = TODAY;
  const shut = { done: '', stuck: '', block: '', next3: '' };
  $id('sd-done').value = ''; $id('sd-stuck').value = ''; $id('sd-block').value = ''; $id('sd-next').value = '';
  /* 预填：今天已完成任务作为「干成什么」草稿 */
  const doneToday = S.tasks.filter(t => t.status === 'done' && t.doneAt === TODAY);
  if (doneToday.length) $id('sd-done').value = doneToday.map(t => t.title).join('；');
  $id('sd-date').textContent = TODAY + ' ' + S.shutdownTime;
  openModal('mw-shutdown');
}
/* 包3 #12：站会三问之「阻碍」一键转风险任务（每行一条，进收件箱/当前项目） */
let blocking = false; /* 转换中防重：双击会重复建整套风险任务 */
export async function shutdownBlockToTask() {
  if (blocking) return;
  const raw = $id('sd-block').value.trim();
  if (!raw) { toast('先在「阻碍」里写点什么', 'info'); return; }
  const p = curProject();
  const pid = p ? p.id : 0;
  const btn = $id('sd-block2task');
  blocking = true;
  if (btn) btn.disabled = true;
  let n = 0;
  try {
    for (const line of raw.split('\n')) {
      const txt = line.replace(/^[-*•\s]+/, '').trim();
      if (!txt) continue;
      try {
        await persistTask({ id: 0, projectId: pid, title: txt.slice(0, 60), due: TODAY, owner: '我方', pri: 'P1', status: 'todo', doneAt: '', risk: true, repeat: '', note: '⛔ 来自收尾问答（阻碍）' + TODAY, createdAt: TODAY, sortOrder: 0, checklistJson: '[]' });
        n++;
      } catch (e) {}
    }
    toast(n ? '🛡 已把 ' + n + ' 条阻碍转成风险任务（计入日报风险栏）' : '没有可转换的阻碍行', n ? 'ok' : 'info');
  } finally {
    blocking = false;
    if (btn) btn.disabled = false;
  }
}
export async function saveShutdown() {
  const data = { done: $id('sd-done').value.trim(), stuck: $id('sd-stuck').value.trim(), block: $id('sd-block').value.trim(), next3: $id('sd-next').value.trim() };
  try {
    await invoke('set_meta', { key: 'shutdown_' + TODAY, value: JSON.stringify(data) });
    closeModal('mw-shutdown');
    toast('已记录收尾问答，明天生成日报时自动引用 ✔');
  } catch (e) { toastErr('保存失败', e); }
}
export function skipShutdown() { closeModal('mw-shutdown'); }
/* 手动打开收尾问答（命令面板「🌙 收尾问答」入口）：不校验时间与当日是否已弹过，已保存过也可再改 */
export async function openShutdownManual() {
  $id('sd-done').value = ''; $id('sd-stuck').value = ''; $id('sd-block').value = ''; $id('sd-next').value = '';
  /* 当日已保存过则回填，否则只改一栏保存会把其余三栏的既有内容用空值覆盖 */
  let saved = null;
  try { saved = await getShutdownMeta(TODAY); } catch (e) {}
  if (saved) {
    $id('sd-done').value = saved.done || '';
    $id('sd-stuck').value = saved.stuck || '';
    $id('sd-block').value = saved.block || '';
    $id('sd-next').value = saved.next3 || '';
  } else {
    const doneToday = S.tasks.filter(t => t.status === 'done' && t.doneAt === TODAY);
    if (doneToday.length) $id('sd-done').value = doneToday.map(t => t.title).join('；');
  }
  $id('sd-date').textContent = TODAY + (S.shutdownTime ? ' ' + S.shutdownTime : '');
  openModal('mw-shutdown');
}
