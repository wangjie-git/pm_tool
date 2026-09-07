/* 设置弹窗、主题 —— 拆分自 ui/app.js（来源行 4576-4635, 4754-4764） */

import { aiActiveId, aiFillSettings, aiProfiles, aiRenderProfiles, aiResetProfiles, aiSetSelection, aiStashFields, aiStatus, loadAiProfiles } from './ai.js';
import { getJsonMeta, invoke, putJsonMeta } from './backend.js';
import { closeModal, openModal } from './modal.js';
import { render } from './render.js';
import { S } from './state.js';
import { loadRules } from './tasks.js';
import { $id, toast, toastErr } from './utils.js';


/* ============ 设置（自动化规则 #13 + 收尾时间 + AI 模型） ============ */
export function stShowSection(sec) {
  document.querySelectorAll('#stTabs button').forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
  document.querySelectorAll('#mw-settings .st-sec').forEach(s => { s.hidden = s.dataset.sec !== sec; });
}
export async function openSettings() {
  await loadRules();
  $id('st-overdueTop').checked = !!S.rules.overdueTop;
  $id('st-staleCleanup').checked = !!S.rules.staleCleanup;
  $id('st-doneStopTimer').checked = !!S.rules.doneStopTimer;
  $id('st-inboxNudge').checked = !!S.rules.inboxNudge;
  $id('st-shutdown').value = S.shutdownTime || '';
  $id('st-density').checked = S.density !== 'cozy'; /* 默认紧凑 */
  try { $id('st-autostart').checked = await invoke('autostart_status'); } catch (e) { $id('st-autostart').checked = false; }
  $id('st-hotkey').value = await invoke('get_meta', { key: 'quickHotkey' }).catch(() => '') || 'Alt+Shift+A';
  $id('st-goal').value = S.dailyGoal || 5;
  try {
    const profiles = await loadAiProfiles();
    let activeId = await getJsonMeta('aiActiveId', null);
    if (!profiles.some(p => p.id === activeId)) activeId = profiles[0].id;
    aiSetSelection(profiles, activeId);
    aiRenderProfiles();
    aiFillSettings(profiles.find(p => p.id === activeId));
  } catch (e) { aiResetProfiles(); aiFillSettings({}); }
  aiStatus('');
  stShowSection('general');
  openModal('mw-settings');
}
let svSaving = false; /* 保存中防重：双击只执行一轮写库与一条提示 */
export async function saveSettings() {
  if (svSaving) return;
  svSaving = true;
  const sb = $id('st-save');
  if (sb) { sb.disabled = true; sb.textContent = '⏳ 保存中…'; }
  try {
    S.rules = {
    overdueTop: $id('st-overdueTop').checked ? 1 : 0,
    staleCleanup: $id('st-staleCleanup').checked ? 1 : 0,
    doneStopTimer: $id('st-doneStopTimer').checked ? 1 : 0,
    inboxNudge: $id('st-inboxNudge').checked ? 1 : 0
  };
  await putJsonMeta('autoRules', S.rules);
  const st = $id('st-shutdown').value.trim();
  S.shutdownTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(st) ? (/^\d:/).test(st) ? '0' + st : st : '';
  await invoke('set_meta', { key: 'shutdownTime', value: S.shutdownTime });
  /* 桌面集成（包2）：自启 / 全局热键 / 今日目标 */
  try {
    const auto = await invoke('autostart_set', { enable: $id('st-autostart').checked });
    if (!auto && $id('st-autostart').checked) toast('开机自启设置未生效（可尝试以管理员运行一次）', 'info');
  } catch (e) { toastErr('设置开机自启失败', e); }
  try {
    const hk = $id('st-hotkey').value.trim() || 'off';
    await invoke('set_quick_hotkey', { hotkey: hk });
    await invoke('set_meta', { key: 'quickHotkey', value: hk === 'off' ? '' : hk });
  } catch (e) { toastErr('设置全局热键失败', e); }
  S.dailyGoal = (() => { const g = +$id('st-goal').value; return (Number.isFinite(g) && g >= 0) ? Math.round(g) : 5; })(); /* 0 = 关闭任务栏进度；空/非法 = 默认 5 */
  await invoke('set_meta', { key: 'dailyGoal', value: String(S.dailyGoal) });
  /* 卡片密度（动线1）：紧凑默认，舒适可选 */
  S.density = $id('st-density').checked ? 'compact' : 'cozy';
  await invoke('set_meta', { key: 'density', value: S.density }).catch(() => {});
  if (aiProfiles.length) {
    aiStashFields();
    await putJsonMeta('aiProviders', aiProfiles);
    await putJsonMeta('aiActiveId', aiActiveId);
  }
  closeModal('mw-settings');
  render();
  toast('设置已保存' + (S.shutdownTime ? '，每天 ' + S.shutdownTime + ' 弹收尾三问' : '，收尾问答已关闭'));
  } finally {
    svSaving = false;
    if (sb) { sb.disabled = false; sb.textContent = '保存'; }
  }
}
/* ============ 主题 ============ */
export function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  $id('btnTheme').textContent = S.theme === 'dark' ? '☀️' : '🌙';
}
export async function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  try { await invoke('set_meta', { key: 'theme', value: S.theme }); } catch (e) {}
}

