/* 通用弹窗、confirm/prompt —— 拆分自 ui/app.js（来源行 2911-2937） */

import { $id } from './utils.js';

export function openModal(id) { $id(id).hidden = false; }
export function closeModal(id) { $id(id).hidden = true; }

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

