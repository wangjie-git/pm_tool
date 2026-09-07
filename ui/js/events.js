/* 全部事件绑定 —— 拆分自 ui/app.js（来源行 4765-5007）
 * v2.2：字母/数字快捷键改用 e.code（布局/大小写/IME 无关，修 A1）；
 *       键盘行导航 ↑↓/J K/空格/Enter/X（动线2）；搜索回车=全局搜索（动线3）；
 *       快速添加语法按钮收敛为「？」面板（A6） */

import { AI_PRESETS, aiAddProfile, aiDelProfile, aiFetchModels, aiGenChecklist, aiImportParsed, aiParseTasks, aiPolishReport, aiPresetChanged, aiStatus, aiTestConn, openAiTask } from './ai.js';
import { invoke } from './backend.js';
import { exportBackup, exportCsv, importBackup } from './backup.js';
import { exportProjectXlsx, openExcelWizard, xwImport, xwNext } from './excel.js';
import { askReminderTime, closeFocusOverlay, focusFinish, openFocusOverlay, saveFocusNote } from './focus.js';
import { markTourSeen, switchPage, switchTab } from './main.js';
import { answerConfirm, answerPrompt, closeModal } from './modal.js';
import { createProjectFromModal, deleteTemplateFromModal, openNewProject } from './modals/newproject.js';
import { deleteProjectFlow, openProjectSettings, saveProjectAsTemplate, saveProjectAsTemplateOf, saveProjectModal, toggleWhSecret } from './modals/project.js';
import { askDelTask, clAdd, editingTaskId, onProjectChange, openTaskEdit, pasteNoteImage, saveTaskModal, updateClSummary, updateRiskEditor } from './modals/task-edit.js';
import { openPalette, palIdx, palMove, palPick, renderPalette } from './palette.js';
import { hideQPop, qPopKind, qTogglePop, quickAdd, quickPreviewRender, toggleQInbox } from './quickadd.js';
import { render, renderView } from './render.js';
import { copyReport, sendReportToGroup } from './report.js';
import { openSettings, saveSettings, stShowSection, toggleTheme } from './settings.js';
import { saveShutdown, shutdownBlockToTask, skipShutdown } from './shutdown.js';
import { S, curProject, getTask } from './state.js';
import { kbMove, kbToggleDone, openTrash, purgeTrashOld, switchProject, toggleTaskSel } from './tasks.js';
import { $id, esc, handleWikilinkClick, toast, toastErr } from './utils.js';
import { exportProjectMd } from './views/archive.js';
import { bindKanbanDrag } from './views/board.js';
import { deleteContactFlow, saveContactModal } from './views/contacts.js';
import { deleteDecisionFlow, saveDecisionModal } from './views/decisions.js';
import { convertIdeaNow } from './views/ideas.js';
import { openSaveSmartView, parseSmartNl, saveSmartViewModal } from './views/inbox.js';
import { deleteMeetingFlow, mtItemAdd, saveMeetingModal } from './views/meetings.js';
import { cardMenuHtml, closeCardMenus, copyTodayList } from './views/today.js';

/* ---------- 右键菜单辅助（动线2） ---------- */
export function closeCtxMenu() { const m = $id('ctxMenu'); if (m) m.hidden = true; }
function positionCtxMenu(e, menu) {
  closeCardMenus();
  /* 用菜单实际宽度做右缘钳制（菜单已显示，offsetWidth 有效），避免固定 250px 估算溢出或留空 */
  const mw = menu.offsetWidth || 250;
  const mx = Math.max(4, Math.min(e.clientX, window.innerWidth - mw - 8));
  const my = Math.max(4, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10));
  menu.style.left = mx + 'px';
  menu.style.top = my + 'px';
}
/* 侧栏项目右键动作：先切到该项目，再执行设置/模板/导出 */
export async function ctxProjAct(pid, act) {
  closeCtxMenu();
  await switchProject(pid);
  if (act === 'settings') openProjectSettings(pid);
  else if (act === 'tpl') saveProjectAsTemplateOf(pid);
  else if (act === 'xlsx') openExcelWizard();
  else if (act === 'csv') exportCsv();
  else if (act === 'md') exportProjectMd();
}

/* ============ 事件绑定 ============ */
export function bindEvents() {
  $id('btnNewProj').onclick = openNewProject;
  $id('btnTheme').onclick = toggleTheme;
  $id('btnRemind').onclick = askReminderTime;
  $id('btnSettings').onclick = openSettings;
  $id('btnTrash').onclick = openTrash;
  $id('btnAddSmart').onclick = openSaveSmartView;
  $id('btnTodayCopy').onclick = copyTodayList;
  $id('qProj').onchange = e => { S.quickPid = e.target.value; };
  /* 项目工具菜单（⋯） */
  $id('btnProjMore').onclick = e => { e.stopPropagation(); $id('projMenu').hidden = !$id('projMenu').hidden; };
  $id('projMenu').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    $id('projMenu').hidden = true;
    const p = curProject(); if (!p) return;
    const act = btn.dataset.act;
    if (act === 'xlsx') openExcelWizard();
    else if (act === 'xlsx-out') exportProjectXlsx();
    else if (act === 'csv') exportCsv();
    else if (act === 'md') exportProjectMd();
    else if (act === 'settings') openProjectSettings(p.id);
    else if (act === 'tpl') { saveProjectAsTemplateOf(p.id); }
  });
  /* A3：点项目名打开设置后不再常驻「设置里程碑倒计时」教学提示（仅项目视图可点，与其他模式 cursor:default 一致） */
  $id('projName').onclick = () => {
    try { localStorage.setItem('pm_ms_hint_done', '1'); } catch (e) {}
    if (S.mode !== 'project') return;
    const p = curProject(); if (p) openProjectSettings(p.id);
  };
  $id('btnQuickAdd').onclick = quickAdd;
  $id('quick').addEventListener('keydown', e => {
    /* 中文 IME 组合态（候选词回车上屏 / 组字中）的按键不当作提交或语法符号（修：与全局键盘 A1 同规则） */
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); quickAdd(); }
    /* A6：输入 / 呼出语法面板（空输入或空格后），不打断正常打字 */
    else if (e.code === 'Slash' && (!e.target.value.trim() || /\s$/.test(e.target.value))) {
      e.preventDefault(); qTogglePop('syntax', $id('q-syntax'));
    }
  });
  $id('quick').addEventListener('input', quickPreviewRender);
  $id('q-syntax').onclick = e => { e.stopPropagation(); qTogglePop('syntax', $id('q-syntax')); };
  $id('q-inbox').onclick = toggleQInbox;
  bindKanbanDrag();

  /* 搜索：输入=筛选当前视图；回车=跨项目全局搜索（动线3）；清空后自动退出搜索页 */
  $id('search').addEventListener('input', e => {
    S.search = e.target.value;
    if (!e.target.value.trim() && S.mode === 'search') { S.mode = 'project'; render(); }
    else renderView();
  });
  $id('search').addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return; /* IME 上屏回车不触发全局搜索 */
    if (e.key === 'Enter' && e.target.value.trim()) {
      e.preventDefault();
      S.mode = 'search';
      render(); /* 完整渲染：页头标题/页签也要切换 */
    }
  });

  /* 一级页签：项目下的四个页面 */
  document.querySelectorAll('#pageTabs button').forEach(b => {
    b.onclick = () => switchPage(b.dataset.page);
  });
  /* 二级分段控件：任务页四种呈现 */
  document.querySelectorAll('#viewSeg button').forEach(b => {
    b.onclick = () => switchTab(b.dataset.view);
  });

  /* 任务编辑弹窗：保存 / 保存并新建 / 换项目联动父任务 / 清单摘要 / 粘贴截图 */
  $id('m-save').onclick = () => saveTaskModal(false);
  $id('m-save-new').onclick = () => saveTaskModal(true);
  $id('m-cancel').onclick = () => closeModal('mw-task');
  $id('m-del').onclick = () => askDelTask(editingTaskId);
  $id('m-cl-add').onclick = clAdd;
  $id('m-cl-input').addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); clAdd(); } });
  $id('m-risk').onchange = updateRiskEditor;
  $id('m-prob').onchange = updateRiskEditor;
  $id('m-impact').onchange = updateRiskEditor;
  $id('m-proj').onchange = onProjectChange;
  $id('m-title').addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); saveTaskModal(false); } });
  $id('m-note').addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) return; if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveTaskModal(false); } });
  $id('m-note').addEventListener('input', updateClSummary);
  $id('m-note').addEventListener('paste', pasteNoteImage);

  $id('p-save').onclick = saveProjectModal;
  $id('p-cancel').onclick = () => closeModal('mw-proj');
  $id('p-delete').onclick = deleteProjectFlow;
  $id('p-save-tpl').onclick = saveProjectAsTemplate;
  $id('p-wh-type').onchange = toggleWhSecret;

  $id('np-create').onclick = createProjectFromModal;
  $id('np-cancel').onclick = () => closeModal('mw-newproj');
  $id('np-name').addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') createProjectFromModal(); });
  $id('np-del-tpl').onclick = deleteTemplateFromModal;

  $id('r-copy').onclick = copyReport;
  $id('r-close').onclick = () => closeModal('mw-report');
  $id('r-wh').onclick = sendReportToGroup;
  $id('r-ai').onclick = aiPolishReport;

  $id('tr-close').onclick = () => closeModal('mw-trash');
  $id('tr-purge-old').onclick = purgeTrashOld;

  $id('sd-save').onclick = saveShutdown;
  $id('sd-skip').onclick = skipShutdown;

  $id('st-save').onclick = saveSettings;
  $id('st-cancel').onclick = () => closeModal('mw-settings');
  /* 设置：五节导航 + 数据节按钮 */
  document.querySelectorAll('#stTabs button').forEach(b => {
    b.onclick = () => stShowSection(b.dataset.sec);
  });
  $id('st-export').onclick = exportBackup;
  $id('st-import').onclick = importBackup;
  $id('st-trash').onclick = openTrash;
  $id('st-backup-now').onclick = async () => {
    try { const path = await invoke('backup_now'); toast(path ? '已备份：' + path : '已备份完成', 'ok'); }
    catch (e) { toastErr('备份失败', e); }
  };
  $id('st-ai-preset').innerHTML = AI_PRESETS.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
  $id('st-ai-preset').onchange = aiPresetChanged;
  $id('st-ai-models').onclick = aiFetchModels;
  $id('st-ai-test').onclick = aiTestConn;
  $id('st-ai-add').onclick = aiAddProfile;
  $id('st-ai-del').onclick = aiDelProfile;
  $id('st-ai-show').onchange = () => { $id('st-ai-key').type = $id('st-ai-show').checked ? 'text' : 'password'; };

  $id('sv-save').onclick = saveSmartViewModal;
  $id('sv-cancel').onclick = () => closeModal('mw-smart');
  $id('sv-nl-parse').onclick = parseSmartNl;

  $id('cv-ok').onclick = convertIdeaNow;
  $id('cv-cancel').onclick = () => closeModal('mw-convert');

  $id('c-ok').onclick = () => answerConfirm(true);
  $id('c-cancel').onclick = () => answerConfirm(false);

  $id('q-aitask').onclick = openAiTask;
  $id('at-parse').onclick = aiParseTasks;
  $id('at-import').onclick = aiImportParsed;
  $id('at-cancel').onclick = () => closeModal('mw-aitask');
  $id('at-input').addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); aiParseTasks(); }
  });
  $id('m-cl-ai').onclick = aiGenChecklist;
  $id('pr-ok').onclick = () => answerPrompt($id('pr-input').value.trim());
  $id('pr-cancel').onclick = () => answerPrompt(null);
  $id('pr-input').addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return; /* IME 上屏回车不提交 prompt */
    if (e.key === 'Enter') answerPrompt($id('pr-input').value.trim());
  });

  /* ---------- v1.5 新增接线 ---------- */
  /* 决策 */
  $id('d-save').onclick = saveDecisionModal;
  $id('d-cancel').onclick = () => closeModal('mw-decision');
  $id('d-del').onclick = deleteDecisionFlow;
  /* 会议 */
  $id('mt-save').onclick = saveMeetingModal;
  $id('mt-cancel').onclick = () => closeModal('mw-meeting');
  $id('mt-del').onclick = deleteMeetingFlow;
  $id('mt-item-add').onclick = mtItemAdd;
  $id('mt-item-input').addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); mtItemAdd(); } });
  /* 干系人 */
  $id('ct-save').onclick = saveContactModal;
  $id('ct-cancel').onclick = () => closeModal('mw-contact');
  $id('ct-del').onclick = () => { const id = +$id('ct-id').value; if (id) { closeModal('mw-contact'); deleteContactFlow(id); } };
  /* Excel 向导 */
  $id('xw-next').onclick = xwNext;
  $id('xw-import').onclick = xwImport;
  $id('xw-cancel').onclick = () => closeModal('mw-xlsx');
  $id('xw-export').onclick = () => { closeModal('mw-xlsx'); exportProjectXlsx(); };
  /* 专注会话 */
  $id('fc-finish').onclick = focusFinish;
  $id('fc-minimize').onclick = closeFocusOverlay;
  $id('fc-save-note').onclick = saveFocusNote;
  /* 收尾问答：阻碍一键转风险任务 */
  $id('sd-block2task').onclick = shutdownBlockToTask;
  /* 设置：热键试一下 */
  $id('st-hotkey-test').onclick = async () => {
    const hk = $id('st-hotkey').value.trim() || 'off';
    try {
      await invoke('set_quick_hotkey', { hotkey: hk });
      aiStatus('✅ 热键已临时生效：' + (hk === 'off' ? '已关闭' : hk) + '（按底部保存后长期有效）');
    } catch (e) { aiStatus('❌ ' + (e && e.message || e), true); }
  };
  /* [[反链]] 点击代理（全局委托） */
  document.addEventListener('click', handleWikilinkClick);
  /* ---------- 右键菜单（动线2）：卡片 = ⋯ 菜单同款；侧栏项目 = 设置/模板/导出 ---------- */
  document.addEventListener('contextmenu', e => {
    if (e.target.closest && e.target.closest('input, textarea, select')) { closeCtxMenu(); return; }
    const menu = $id('ctxMenu');
    const card = e.target.closest ? e.target.closest('.card[data-id]') : null;
    if (card) {
      e.preventDefault();
      const t = getTask(+card.getAttribute('data-id'));
      if (!t) { closeCtxMenu(); return; }
      menu.innerHTML = cardMenuHtml(t);
      menu.hidden = false;
      positionCtxMenu(e, menu);
      return;
    }
    const proj = e.target.closest ? e.target.closest('.proj[data-pid]') : null;
    if (proj) {
      e.preventDefault();
      const pid = +proj.getAttribute('data-pid');
      menu.innerHTML = '<button onclick="ctxProjAct(' + pid + ',\'settings\')">⚙ 项目设置</button>'
        + '<button onclick="ctxProjAct(' + pid + ',\'tpl\')">💾 另存为项目模板</button>'
        + '<div class="menu-sep"></div>'
        + '<button onclick="ctxProjAct(' + pid + ',\'xlsx\')">📥 Excel 导入 / 📤 导出 .xlsx</button>'
        + '<button onclick="ctxProjAct(' + pid + ',\'csv\')">📄 导出 CSV</button>'
        + '<button onclick="ctxProjAct(' + pid + ',\'md\')">📝 导出项目 Markdown</button>';
      menu.hidden = false;
      positionCtxMenu(e, menu);
      return;
    }
    closeCtxMenu();
  });
  /* 计时条专注按钮 */
  const tbFocus = document.querySelector('#timerBar .btn.blue.ghost');
  if (tbFocus) tbFocus.onclick = openFocusOverlay;

  ['mw-task', 'mw-proj', 'mw-report', 'mw-confirm', 'mw-prompt', 'mw-palette', 'mw-newproj', 'mw-trash', 'mw-shutdown', 'mw-settings', 'mw-smart', 'mw-convert', 'mw-aitask', 'mw-decision', 'mw-meeting', 'mw-contact', 'mw-xlsx', 'mw-focus', 'mw-tour'].forEach(wid => {
    $id(wid).addEventListener('mousedown', e => {
      if (e.target === $id(wid)) {
        if (wid === 'mw-confirm') answerConfirm(false);
        else if (wid === 'mw-prompt') answerPrompt(null);
        else if (wid === 'mw-shutdown') skipShutdown();
        else if (wid === 'mw-focus') closeFocusOverlay();
        else if (wid === 'mw-tour') markTourSeen();
        else closeModal(wid);
      }
    });
  });

  /* 命令面板输入 */
  $id('pal-input').addEventListener('input', e => renderPalette(e.target.value));
  $id('pal-input').addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return; /* IME 组合态的方向键/回车交给输入法 */
    if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); palPick(palIdx); }
  });

  document.addEventListener('mousedown', e => {
    if (qPopKind && !e.target.closest('#qPop') && !e.target.closest('.q-tools')) hideQPop();
    /* 点击项目工具菜单（⋯）外部时收起菜单 */
    if (!e.target.closest('#projMoreWrap')) $id('projMenu').hidden = true;
    /* 点击任务卡 ⋯ 菜单外部时收起 */
    if (!e.target.closest('.card-menu') && !e.target.closest('.more-btn')) closeCardMenus();
    /* 点击右键菜单外部时收起 */
    if (!e.target.closest('#ctxMenu')) closeCtxMenu();
  });

  /* ============ 全局键盘（v2.2：e.code 实现，IME/大小写/布局免疫；动线2 键盘流） ============ */
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return; /* 中文 IME 组合中的按键不处理（修 A1） */
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    const code = e.code;
    if (code === 'Escape') {
      if (qPopKind) { hideQPop(); return; }
      if (!$id('projMenu').hidden) { $id('projMenu').hidden = true; return; }
      if (document.querySelector('.card-menu:not([hidden])')) { closeCardMenus(); return; }
      if (document.getElementById('ctxMenu') && !document.getElementById('ctxMenu').hidden) { closeCtxMenu(); return; }
      if (document.querySelector('.cal-day-pop')) { const p2 = document.querySelector('.cal-day-pop'); p2.remove(); return; }
      const open = ['mw-prompt', 'mw-confirm', 'mw-palette', 'mw-task', 'mw-proj', 'mw-report', 'mw-newproj', 'mw-trash', 'mw-shutdown', 'mw-settings', 'mw-smart', 'mw-convert', 'mw-aitask', 'mw-decision', 'mw-meeting', 'mw-contact', 'mw-xlsx', 'mw-focus', 'mw-tour'].find(w => !$id(w).hidden);
      if (open === 'mw-prompt') answerPrompt(null);
      else if (open === 'mw-confirm') answerConfirm(false);
      else if (open === 'mw-shutdown') skipShutdown();
      else if (open === 'mw-focus') closeFocusOverlay();
      else if (open === 'mw-tour') markTourSeen();
      else if (open) closeModal(open);
      return;
    }
    /* Ctrl+K：命令面板（输入焦点不在输入框时也生效） */
    if ((e.ctrlKey || e.metaKey) && code === 'KeyK') {
      e.preventDefault();
      if ($id('mw-palette').hidden) openPalette(); else closeModal('mw-palette');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && code === 'KeyF') {
      e.preventDefault(); $id('search').focus(); $id('search').select();
      return;
    }
    if (typing) return;
    /* 有弹窗打开时不响应行导航/快捷键 */
    const modalOpen = ['mw-task', 'mw-proj', 'mw-report', 'mw-confirm', 'mw-prompt', 'mw-palette', 'mw-newproj', 'mw-trash', 'mw-shutdown', 'mw-settings', 'mw-smart', 'mw-convert', 'mw-aitask', 'mw-decision', 'mw-meeting', 'mw-contact', 'mw-xlsx', 'mw-focus', 'mw-tour'].some(w => !$id(w).hidden);
    if (modalOpen) return;
    /* 键盘行导航（动线2）：↑↓ / J K 移行，空格完成，X 选中，Enter 详情 */
    if (code === 'KeyJ' || code === 'ArrowDown') { e.preventDefault(); kbMove(1); return; }
    if (code === 'KeyK' || code === 'ArrowUp') { e.preventDefault(); kbMove(-1); return; }
    if (code === 'Space') { e.preventDefault(); kbToggleDone(); return; }
    if (code === 'KeyX') { if (S.kbId != null) { e.preventDefault(); toggleTaskSel(S.kbId); } return; }
    if (code === 'Enter') { if (S.kbId != null) { e.preventDefault(); openTaskEdit(S.kbId); } return; }
    if (code === 'Slash') { e.preventDefault(); $id('search').focus(); $id('search').select(); return; }
    if (code === 'KeyN') { e.preventDefault(); openTaskEdit(0); return; }
    /* 1-7 切视图：Digit 系列，键盘布局无关 */
    if (code.indexOf('Digit') === 0) {
      const map = { 1: 'list', 2: 'kanban', 3: 'calendar', 4: 'timeline', 5: 'stats', 6: 'decisions', 7: 'archive' };
      const v = map[code.slice(5)];
      if (v) switchTab(v);
      return;
    }
  });
}
