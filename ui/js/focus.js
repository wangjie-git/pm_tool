/* 专注模式浮层、任务栏进度 —— 拆分自 ui/app.js（来源行 3629-3748） */

import { invoke } from './backend.js';
import { askPrompt, closeModal, openModal } from './modal.js';
import { render, renderView } from './render.js';
import { S, TODAY, getTask } from './state.js';
import { timerText, updateTimerBar } from './tasks.js';
import { $id, pad, toast, toastErr } from './utils.js';

/* ============ 包4 #17：专注会话（全屏视图 + 可选倒计时 + 一句收尾） ============ */
export let focusTickTimer = null;
let focusFinishing = false; /* 双击「结束专注」防重：第二次调用直接忽略，避免 0 分钟覆写与重复通知 */

export function openFocusOverlay() {
  if (!S.timer) { toast('先在任务卡上点 ⏱ 开始计时', 'info'); return; }
  const t = getTask(S.timer.taskId);
  $id('fc-task').textContent = t ? t.title : '（任务不存在）';
  $id('fc-time').textContent = timerText(S.timer.startedAt);
  $id('fc-wrap').hidden = true;
  $id('fc-note').value = ''; /* 清上一轮未保存的收尾文字，防止误提交旧笔记 */
  document.querySelector('input[name="fc-mode"][value="up"]').checked = true;
  openModal('mw-focus');
  if (focusTickTimer) clearInterval(focusTickTimer);
  focusTickTimer = setInterval(focusTick, 500);
  focusTick();
}
export function focusMode() {
  const el = document.querySelector('input[name="fc-mode"]:checked');
  return el ? el.value : 'up';
}
export function focusTotalSecs() {
  return (+$id('fc-mins').value || 25) * 60;
}
export function focusTick() {
  if (!S.timer) { closeFocusOverlay(); return; }
  const t = getTask(S.timer.taskId);
  $id('fc-task').textContent = t ? t.title : '（任务不存在）';
  const now = Math.floor(Date.now() / 1000);
  if (focusMode() === 'down') {
    const total = focusTotalSecs();
    const elapsed = now - S.timer.startedAt;
    const remain = Math.max(0, total - elapsed);
    const h2 = Math.floor(remain / 3600), m = Math.floor((remain % 3600) / 60), s = remain % 60;
    $id('fc-time').textContent = pad(h2) + ':' + pad(m) + ':' + pad(s);
    $id('fc-bar').style.width = Math.min(100, Math.round(elapsed / total * 100)) + '%';
    if (remain <= 0) { focusFinish(); return; }
  } else {
    $id('fc-time').textContent = timerText(S.timer.startedAt);
    $id('fc-bar').style.width = '0%';
  }
}
export async function focusFinish() {
  if (focusFinishing) return; /* 双击防护：第二次点击直接忽略 */
  focusFinishing = true;
  if (focusTickTimer) { clearInterval(focusTickTimer); focusTickTimer = null; }
  const t = getTask(S.timer ? S.timer.taskId : 0);
  try {
    const mins = await invoke('stop_timer');
    S.timer = null;
    updateTimerBar();
    $id('fc-wrap').hidden = false;
    window._fcLastMins = mins;
    window._fcLastTask = t ? t.title : '';
    if (window.__TAURI__.core && !window.__TAURI__._isMock) { try { await invoke('notify_desktop', { title: '专注完成', body: '本轮 ' + mins + ' 分钟，写一句收尾吧' }); } catch (e) {} }
  } catch (e) { toastErr('停止计时失败', e); closeModal('mw-focus'); }
  render();
  updateTaskbarProgress();
  focusFinishing = false;
}
export async function saveFocusNote() {
  const note = $id('fc-note').value.trim();
  closeModal('mw-focus');
  $id('fc-note').value = '';
  if (!note) return;
  const line = '- [专注 ' + (window._fcLastMins || 0) + ' 分钟] ' + note + (window._fcLastTask ? '（' + window._fcLastTask + '）' : '');
  try {
    const key = 'dailyNote_' + TODAY;
    const cur = await invoke('get_meta', { key: key }).catch(() => '') || '';
    const val = cur ? cur + '\n' + line : line;
    await invoke('set_meta', { key: key, value: val });
    toast('已写入每日笔记：' + note.slice(0, 20));
    if (S.mode === 'dailynote') renderView();
  } catch (e) { toastErr('写入笔记失败', e); }
}
export function closeFocusOverlay() {
  if (focusTickTimer) { clearInterval(focusTickTimer); focusTickTimer = null; }
  closeModal('mw-focus');
}

/* ============ 包2 #6：任务栏进度条 ============ */
export let _lastTb = null;
export async function updateTaskbarProgress() {
  let want = null;
  if (S.timer && $id('mw-focus') && !$id('mw-focus').hidden && focusMode() === 'down') {
    const total = focusTotalSecs();
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - S.timer.startedAt);
    want = { mode: 'normal', value: Math.min(100, Math.round(elapsed / total * 100)) };
  } else if (S.timer) {
    want = { mode: 'indeterminate', value: 0 };
  } else if (S.dailyGoal > 0) {
    const doneToday = S.tasks.filter(t => t.status === 'done' && (t.doneAt || '').slice(0, 10) === TODAY).length;
    want = { mode: 'normal', value: Math.min(100, Math.round(doneToday / S.dailyGoal * 100)) };
  } else {
    want = { mode: 'none', value: 0 };
  }
  const sig = want.mode + ':' + want.value;
  if (sig === _lastTb) return;
  _lastTb = sig;
  try { await invoke('taskbar_progress', { mode: want.mode, value: want.value }); } catch (e) {}
}


export async function askReminderTime() {
  let cur = '';
  try { cur = await invoke('get_meta', { key: 'notifyTime' }) || ''; } catch (e) {}
  const v = await askPrompt('每日定时提醒',
    '到点通知今日到期任务，如 09:30；输入 off 关闭。当前：' + (cur || '关闭'), cur || '09:30');
  if (v === null) return;
  const s = v.trim();
  if (!s || s.toLowerCase() === 'off') {
    await invoke('set_meta', { key: 'notifyTime', value: '' }).catch(e => toastErr('保存失败', e));
    updateRemindBtn('');
    toast('每日提醒已关闭', 'info');
    return;
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) { toast('格式不对，示例：09:30', 'err'); return; }
  const norm = (/^\d:/).test(s) ? '0' + s : s;
  await invoke('set_meta', { key: 'notifyTime', value: norm }).catch(e => toastErr('保存失败', e));
  updateRemindBtn(norm);
  toast('每天 ' + norm + ' 会提醒你过一遍今日待办（保持软件开机自启更可靠）');
}
export function updateRemindBtn(v) {
  $id('btnRemind').title = '每日定时提醒：' + (v ? v : '未设置（点击配置）');
  $id('btnRemind').classList.toggle('on', !!v);
}

/* ============ 包4 #15：项目 one-pager（档案视图） ============ */
