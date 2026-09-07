/* 通用弹窗、confirm/prompt —— 拆分自 ui/app.js（来源行 2911-2937） */

import { $id } from './utils.js';

/* 弹窗 z 轴递增：所有 .mwrap 静态 z-index 相同（100），层叠顺序 = DOM 顺序，
 * 而 mw-confirm/mw-prompt 在 DOM 里排在 mw-settings/mw-newproj/mw-trash 等之前——
 * 若不提升层级，设置弹窗里点「导入」弹出的覆盖确认会被宿主弹窗完全遮住、点不到。
 * 每次 openModal 递增 zIndex，后打开的弹窗必然盖住先打开的。 */
let _modalZ = 100;
export function openModal(id) {
  const el = $id(id);
  if (!el) return;
  el.hidden = false;
  if (_modalZ > 165) _modalZ = 100; /* 保持在 100~165，不盖过批处理条(180)/Toast(1000)/右键菜单(220) */
  el.style.zIndex = ++_modalZ;
}
export function closeModal(id) { const el = $id(id); if (el) el.hidden = true; }

export let _confirmResolve = null, _promptResolve = null;
export function askConfirm(title, msgHtml, danger) {
  return new Promise(res => {
    _confirmResolve = res;
    $id('c-title').textContent = title;
    $id('c-msg').innerHTML = msgHtml;
    $id('c-ok').className = danger ? 'btn danger' : 'btn blue';
    openModal('mw-confirm');
  });
}
export function answerConfirm(v) { closeModal('mw-confirm'); if (_confirmResolve) { _confirmResolve(v); _confirmResolve = null; } }

export function askPrompt(title, label, def) {
  return new Promise(res => {
    _promptResolve = res;
    $id('pr-title').textContent = title;
    $id('pr-label').textContent = label;
    $id('pr-input').value = def || '';
    openModal('mw-prompt');
    setTimeout(() => { $id('pr-input').focus(); $id('pr-input').select(); }, 30);
  });
}
export function answerPrompt(v) { closeModal('mw-prompt'); if (_promptResolve) { _promptResolve(v); _promptResolve = null; } }

