/* 前端交互冒烟测试 2：逐个调用各视图渲染器与关键动作函数，验证无异常（配合 mock 后端）。
 * 用法：node tools/smoke-ui.js 先通过，再 node tools/smoke-ui2.js */
'use strict';
const path = require('path');

const elCache = {};
function makeEl(id) {
  const lsn = {};
  const el = {
    id: id || 'dyn', hidden: false, disabled: false, checked: false, value: '', textContent: '', innerHTML: '',
    className: '', title: '', placeholder: '', type: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, fn) { lsn[t] = fn; }, removeEventListener() {},
    set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick || null; },
    appendChild() {}, remove() {}, focus() {}, select() {}, scrollIntoView() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 }; },
    setAttribute() {}, getAttribute() { return null; }, cloneNode() { return makeEl(id); },
    getContext() { return { fillRect() {}, drawImage() {}, fillStyle: '' }; },
    toDataURL() { return 'data:image/png;base64,xx'; },
    scrollTop: 0, offsetWidth: 200, offsetHeight: 40,
  };
  return el;
}
const docListeners = {};
global.window = {
  innerWidth: 1280, innerHeight: 800,
  addEventListener(t, fn) { docListeners[t] = fn; }, removeEventListener() {},
  __TAURI__: undefined,
};
global.document = {
  getElementById(id) { return (elCache[id] = elCache[id] || makeEl(id)); },
  querySelector() { return makeEl('qsel'); }, /* 桩元素：focus 面板的 fc-mode radio 等查询拿到可用节点 */
  querySelectorAll() { return []; },
  createElement() { return makeEl('dyn'); }, createElementNS() { return makeEl('dyn'); },
  addEventListener(t, fn) { docListeners[t] = fn; }, removeEventListener() {},
  body: { appendChild() {}, insertAdjacentHTML() {}, classList: { add() {}, remove() {} } },
  documentElement: { dataset: {} },
};
global.localStorage = { _d: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText() { return Promise.resolve(); }, readText() { return Promise.resolve(''); } } }, configurable: true });
global.XMLSerializer = class { serializeToString() { return '<svg/>'; } };
global.Image = class { set src(v) { if (this.onload) setTimeout(() => this.onload(), 0); } };
global.FileReader = class { readAsDataURL() { if (this.onload) setTimeout(() => this.onload({ target: { result: 'data:image/png;base64,xx' } }), 0); } };
global.setInterval = () => 0; global.clearInterval = () => {};
global.requestAnimationFrame = () => 0; global.execCommand = () => true;

const set = (id, patch) => Object.assign(elCache[id] = elCache[id] || makeEl(id), patch);

(async () => {
  let fails = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log('  ✔ ' + name); }
    catch (e) { fails++; console.error('  ✘ ' + name + ' → ' + (e && e.message || e)); }
  };
  try {
    await import('../ui/js/app.js');
    await new Promise(r => setTimeout(r, 100));
    const S = (await import('../ui/js/state.js')).S;
    const render = (await import('../ui/js/render.js')).render;
    const { renderView } = await import('../ui/js/render.js');
    const tasks = await import('../ui/js/tasks.js');
    const qa = await import('../ui/js/quickadd.js');
    const { openTaskEdit, saveTaskModal, clAdd, clToggle, clRemove } = await import('../ui/js/modals/task-edit.js');
    const board = await import('../ui/js/views/board.js');
    const cal = await import('../ui/js/views/calendar.js');
    const gantt = await import('../ui/js/gantt.js');
    const stats = await import('../ui/js/stats.js');
    const excel = await import('../ui/js/excel.js');
    const report = await import('../ui/js/report.js');
    const ideas = await import('../ui/js/views/ideas.js');
    const meetings = await import('../ui/js/views/meetings.js');
    const contacts = await import('../ui/js/views/contacts.js');
    const decisions = await import('../ui/js/views/decisions.js');
    const inbox = await import('../ui/js/views/inbox.js');
    const dn = await import('../ui/js/views/dailynote.js');
    const arch = await import('../ui/js/views/archive.js');
    const search = await import('../ui/js/views/search.js');
    const pal = await import('../ui/js/palette.js');
    const settings = await import('../ui/js/settings.js');
    const shutdown = await import('../ui/js/shutdown.js');
    const focus = await import('../ui/js/focus.js');
    const backup = await import('../ui/js/backup.js');
    const ai = await import('../ui/js/ai.js');

    const pid = S.projects[0].id;

    /* --- 视图渲染 --- */
    await check('render list', () => { S.mode = 'project'; S.view = 'list'; renderView(); });
    await check('render kanban', () => { S.view = 'kanban'; renderView(); });
    await check('render calendar', () => { S.view = 'calendar'; renderView(); });
    await check('render timeline', () => { S.view = 'timeline'; renderView(); });
    await check('render stats', async () => { S.view = 'stats'; await stats.renderStats(); });
    await check('render decisions', () => { S.view = 'decisions'; renderView(); });
    await check('render archive', () => { S.view = 'archive'; renderView(); });
    await check('render today', () => { S.mode = 'today'; renderView(); });
    await check('render inbox', () => { S.mode = 'inbox'; renderView(); });
    await check('render ideas', () => { S.mode = 'ideas'; renderView(); });
    await check('render smart', () => { S.mode = 'smart'; S.smartId = 'risk-reg'; renderView(); });
    await check('render smart 缺 crit（防崩）', () => { S.smartViews.push({ id: 'v-bad', name: '坏视图', builtin: 0 }); S.smartId = 'v-bad'; renderView(); S.smartId = 'risk-reg'; });
    await check('render meetings', () => { S.mode = 'meetings'; renderView(); });
    await check('render contacts', () => { S.mode = 'contacts'; renderView(); });
    await check('render dailynote', async () => { S.mode = 'dailynote'; await dn.renderDailyNote(); });
    await check('render search', () => { S.mode = 'search'; S.search = '日报'; renderView(); S.search = ''; });

    /* --- 任务动作 --- */
    const tid = S.tasks[0].id;
    await check('quickAdd 解析+入库', () => { set('quick', { value: '明天 联调测试 @李四 !P0 #风险' }); return qa.quickAdd(); });
    const tid2 = S.tasks[S.tasks.length - 1].id;
    await check('setStatus done（含 doneStopTimer 路径）', () => tasks.setStatus(tid2, 'done'));
    await check('snoozeTask', () => tasks.snoozeTask(tid2));
    await check('togglePin', () => tasks.togglePin(tid));
    await check('toggleFrog', () => tasks.toggleFrog(tid));
    await check('toggleTimer + stopTimerFlow', async () => { await tasks.toggleTimer(tid); await tasks.stopTimerFlow(false); });
    await check('delTaskById（回收站）', () => tasks.delTaskById(tid2, true));
    await check('openTrash / restoreTrash', async () => { await tasks.openTrash(); const it = await (await import('../ui/js/backend.js')).invoke('list_deleted'); if (it && it[0]) await tasks.restoreTrash(it[0].id); });
    await check('openTaskEdit(0) + clAdd/clToggle/clRemove + saveTaskModal(false)', async () => {
      openTaskEdit(0);
      set('m-title', { value: '冒烟测试任务' });
      set('m-cl-input', { value: '清单项1' }); clAdd();
      clToggle(0); clRemove(0);
      await saveTaskModal(false);
    });
    await check('openTaskEdit(tid) + saveTaskModal(true)（保存并新建）', async () => {
      openTaskEdit(tid);
      set('m-title', { value: '冒烟任务-编辑' });
      await saveTaskModal(true);
      set('m-title', { value: '冒烟任务-新建2' });
      await saveTaskModal(false);
    });
    await check('toggleTaskSel / shiftSelectTo / batchStatus / batchSnoozeSel', async () => {
      tasks.toggleTaskSel(tid); tasks.toggleTaskSel(tid2);
      await tasks.batchStatus('doing');
      await tasks.batchSnoozeSel();
      tasks.clearSelection();
    });

    /* --- 日历 --- */
    await check('calNewAt / calShowDay / calNav / calGoToday', () => {
      cal.calNewAt('2026-09-20');
      cal.calNav(1); cal.calGoToday();
    });

    /* --- 甘特 --- */
    await check('gantt 操作', async () => {
      S.mode = 'project'; S.view = 'timeline'; renderView();
      gantt.ganttSetZoom('week'); gantt.ganttPan(1); gantt.ganttPan(-1);
      await gantt.toggleGanttCompare();
      gantt.ganttNewAtRange(); gantt.ganttNewMilestone();
    });

    /* --- 统计 --- */
    await check('stats runForecast / setStatsRange', async () => {
      S.view = 'stats'; await stats.renderStats();
      await stats.runForecast();
      stats.setStatsRange('all');
      await stats.renderStats();
    });

    /* --- Excel 向导 --- */
    await check('excel 值映射委托监听（data-vm）', () => {
      excel.openExcelWizard();
      excel.XW.valueMap = {};
      const fake = {
        tagName: 'SELECT',
        hasAttribute: a => a === 'data-vm',
        getAttribute: a => (a === 'data-vm' ? '已完成' : null),
        value: 'done'
      };
      if (docListeners['change']) docListeners['change']({ target: fake });
      if (excel.XW.valueMap['已完成'] !== 'done') throw new Error('data-vm 委托监听未生效');
    });
    await check('excel 向导步骤推进 + 空表导入防护', () => {
      excel.openExcelWizard();
      excel.xwNext(); /* 未选表：step 2 不前进（无 sheet） */
      excel.XW.sheets = ['Sheet1']; excel.XW.sheet = 'Sheet1'; excel.XW.rows = [['标题', '截止'], ['任务A', '2026-09-30']];
      excel.XW._rowChoices = [{ idx: 0, label: '第 1 行 ⭐' }]; excel.XW._rowChoiceIdx = 0; excel.XW.headerRow = 0;
      excel.xwAutoMap();
      excel.xwHeaderChanged();
      excel.xwNext(); excel.xwNext(); excel.xwNext();
      return excel.xwImport();
    });

    /* --- 报告 --- */
    await check('report openReport(' + "'day'" + ') / copyReport', async () => {
      await report.openReport('day');
      report.copyReport();
      set('r-area', { value: '测试' });
      await report.sendReportToGroup(); /* 无 webhook → 提示路径 */
    });

    /* --- 想法 --- */
    await check('ideas saveIdea / editIdea / cancelIdeaEdit / convertIdeaNow', async () => {
      set('idea-title', { value: '领导口头诉求：上自动化报表' });
      await ideas.saveIdea();
      const iid = S.ideas[0].id;
      ideas.editIdea(iid);
      ideas.cancelIdeaEdit();
      ideas.openConvertIdea(iid);
      await ideas.convertIdeaNow();
    });

    /* --- 会议 --- */
    await check('meetings 保存/转任务/转决策', async () => {
      meetings.openMeetingModal(0);
      set('mt-title', { value: '甲方周例会' });
      set('mt-item-input', { value: '出联调报告' }); meetings.mtItemAdd();
      await meetings.saveMeetingModal();
      const mid = S.meetings[0].id;
      await meetings.meetingItemToTask(mid, 0);
      await meetings.meetingItemToDecision(mid, 0);
    });

    /* --- 干系人 --- */
    await check('contacts 建档/记录互动', async () => {
      contacts.openContactModal(0);
      set('ct-name', { value: '李四' });
      set('ct-days', { value: '14' });
      await contacts.saveContactModal();
      await contacts.logContactInteraction(S.contacts[0].id);
      await contacts.generateFollowupTasks();
    });

    /* --- 决策 --- */
    await check('decisions 记录', async () => {
      decisions.openDecisionModal(0);
      set('d-title', { value: '闸机厂商定为 B 公司' });
      set('d-decision', { value: '选 B' });
      await decisions.saveDecisionModal();
    });

    /* --- 智能视图 --- */
    const modal = await import('../ui/js/modal.js');
    await check('inbox 智能视图保存/删除', async () => {
      inbox.openSaveSmartView();
      set('sv-name', { value: 'P0 风险盘点' });
      set('sv-risk', { checked: true });
      set('sv-nl', { value: '' });
      await inbox.saveSmartViewModal();
      const v = S.smartViews[S.smartViews.length - 1];
      /* deleteSmartView 内部 await askConfirm：桩环境里先启动再代答确认 */
      const p = inbox.deleteSmartView(v.id).catch(e => { throw e; });
      await new Promise(r => setTimeout(r, 20));
      modal.answerConfirm(true);
      await p;
    });

    /* --- 每日笔记 --- */
    await check('dailynote 保存（含日期戳）', async () => {
      await dn.renderDailyNote();
      const ta = elCache['dn-text'];
      ta.value = '今日记录';
      await dn.saveDailyNoteText();
      dn.dailyNoteNav(1); dn.dailyNoteGoToday();
    });

    /* --- 档案 --- */
    await check('archive 一页纸', async () => {
      S.mode = 'project'; S.view = 'archive'; renderView();
      arch.toggleOnePagerEditor();
      set('op-text', { value: '# 背景' });
      await arch.saveOnePager();
    });

    /* --- 全局搜索跳转 --- */
    await check('search 结果跳转', async () => {
      S.mode = 'search'; S.search = '联调'; renderView();
      await search.searchOpenTask(tid);
      S.mode = 'search'; S.search = '联调'; renderView();
      await search.searchOpenDecision(S.decisions[0].id);
      S.mode = 'search'; S.search = '联调'; renderView();
      await search.searchOpenMeeting(S.meetings[0].id);
    });

    /* --- 命令面板 --- */
    await check('palette 打开/导航/选择', async () => {
      pal.openPalette();
      pal.palMove(1); pal.palMove(-1);
      await pal.palPick(0);
    });

    /* --- 设置 --- */
    await check('settings 打开/保存/主题', async () => {
      await settings.openSettings();
      set('st-shutdown', { value: '18:00' });
      set('st-goal', { value: '5' });
      await settings.saveSettings();
      await settings.toggleTheme();
    });

    /* --- 收尾问答 --- */
    await check('shutdown 手动打开/保存', async () => {
      await shutdown.openShutdownManual();
      set('sd-done', { value: '完成日报' });
      await shutdown.saveShutdown();
      await shutdown.shutdownCheck();
    });

    /* --- 专注 --- */
    await check('focus 打开/结束（先开计时）', async () => {
      await tasks.toggleTimer(tid);
      focus.openFocusOverlay();
      await focus.focusFinish();
    });

    /* --- AI --- */
    await check('ai 档案增删', async () => {
      const before = ai.aiProfiles.length;
      set('st-ai-baseurl', { value: 'https://api.deepseek.com/v1' });
      set('st-ai-model', { value: 'deepseek-chat' });
      set('st-ai-key', { value: 'sk-test' });
      set('st-ai-preset', { value: 'deepseek' });
      await ai.aiAddProfile();
      if (ai.aiProfiles.length !== before + 1) throw new Error('aiAddProfile 后应新增一条档案');
      await ai.aiAddProfile(); /* 连续另存是合法操作：应再建一条且 id 唯一 */
      if (ai.aiProfiles.length !== before + 2) throw new Error('连续 aiAddProfile 应各建一条');
      const n = ai.aiProfiles.length;
      ai.aiDelProfile(); ai.aiDelProfile(); /* 二连击确认删除 */
      if (ai.aiProfiles.length !== n - 1) throw new Error('aiDelProfile 二连击后数量不对（可能 id 重复）');
    });
    await check('ai 解析/导入防护（未配置时走引导）', async () => {
      set('at-input', { value: '周三前交报告' });
      await ai.aiParseTasks();
    });
    await check('aiGenChecklist（未配置 AI 时走引导，不崩溃）', async () => {
      openTaskEdit(tid);
      set('m-title', { value: '冒烟' });
      await ai.aiGenChecklist();
    });

    /* --- 备份导出取消路径 --- */
    await check('backup exportBackup（对话框取消）', async () => {
      await backup.exportBackup();
      await backup.exportCsv();
    });

    /* --- 跨天重置 --- */
    await check('checkDayRollover（同日直接返回）', async () => {
      await tasks.checkDayRollover();
    });

    console.log('');
    if (fails) { console.error('冒烟测试 2 结果：' + fails + ' 项失败'); process.exit(1); }
    console.log('冒烟测试 2 全部通过（' + '全部动作无异常）');
    process.exit(0);
  } catch (e) {
    console.error('SMOKE2 FAIL:', e && e.stack || e);
    process.exit(1);
  }
})();
