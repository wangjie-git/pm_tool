/* window 桥接：index.html 与各视图模板字符串里的内联 onclick 按全局作用域解析，
 * 因此把 HTML 直接引用的函数挂到 window。新增会被模板串引用的函数时，在这里补充。
 * 可变 let（如 XW）用 getter 保持实时绑定，不能赋快照。 */
import { aiPickModel, aiPickProfile } from './ai.js';
import { exportProjectXlsx, xwHeaderChanged, xwMapChanged, xwPickFile, xwSheetChanged, xwValueMap } from './excel.js';
import { ctxProjAct } from './events.js';
import { openFocusOverlay } from './focus.js';
import { exportGanttPng, ganttNewAtRange, ganttNewMilestone, ganttPan, ganttSetZoom, toggleGanttCompare } from './gantt.js';
import { XW } from './excel.js';
import { markTourSeen } from './main.js';
import { openProjectSettings } from './modals/project.js';
import { clRemove, clToggle, jumpBacklink, openTaskEdit, toggleNotePreview } from './modals/task-edit.js';
import { palPick } from './palette.js';
import { hideQPop, qInsert, qPick, qPickOwner, qPickPri, qRemoveToken, quickAddFromClipboard } from './quickadd.js';
import { openContacts, openDailyNote, openIdeas, openInbox, openMeetings, openSmartView } from './render.js';
import { openReport } from './report.js';
import { exportStatsPng, runForecast, setStatsRange } from './stats.js';
import { batchDeleteSel, batchMoveSel, batchSnoozeSel, batchStatus, clearSelection, cycleStatus, delTaskById, purgeTrash, restoreTrash, setStatus, snoozeTask, stopTimerFlow, switchProject, toggleFrog } from './tasks.js';
import { $id, copyText } from './utils.js';
import { exportProjectMd, saveOnePager, toggleOnePagerEditor } from './views/archive.js';
import { calGoToday, calNav, calNewAt, calShowDay } from './views/calendar.js';
import { deleteContactFlow, logContactInteraction, openContactModal } from './views/contacts.js';
import { dailyNoteGoToday, dailyNoteNav, saveDailyNoteText } from './views/dailynote.js';
import { openDecisionModal } from './views/decisions.js';
import { cancelIdeaEdit, deleteIdea, editIdea, openConvertIdea, saveIdea } from './views/ideas.js';
import { adoptSuggestion, assignInbox, deleteSmartView, parseSmartNl } from './views/inbox.js';
import { meetingItemToDecision, meetingItemToTask, mtItemRemove, openMeetingModal } from './views/meetings.js';
import { openDailyNoteDate, searchOpenContact, searchOpenDecision, searchOpenMeeting, searchOpenTask } from './views/search.js';
import { cardMenuAct, cardTitleClick, clearSearch, focusQuickAdd, openTodayFocus, toggleCardMenu, toggleDone } from './views/today.js';
import { setListSort } from './views/board.js';

Object.assign(window, {
  $id, adoptSuggestion, aiPickModel, aiPickProfile, assignInbox, batchDeleteSel, batchMoveSel, batchSnoozeSel, batchStatus,
  calGoToday, calNav, calNewAt, calShowDay, cancelIdeaEdit, cardMenuAct, cardTitleClick, clearSearch, clearSelection, clRemove, clToggle,
  copyText, cycleStatus, dailyNoteGoToday, dailyNoteNav, delTaskById, deleteContactFlow, deleteIdea, deleteSmartView, editIdea,
  ctxProjAct,
  exportGanttPng, exportProjectMd, exportProjectXlsx, exportStatsPng, focusQuickAdd, ganttNewAtRange, ganttNewMilestone, ganttPan, ganttSetZoom,
  hideQPop, jumpBacklink, logContactInteraction, markTourSeen, meetingItemToDecision, meetingItemToTask, mtItemRemove,
  openContactModal, openContacts, openConvertIdea, openDailyNote, openDailyNoteDate, openDecisionModal, openFocusOverlay, openIdeas,
  openInbox, openMeetingModal, openMeetings, openProjectSettings, openReport, openSmartView, openTaskEdit, openTodayFocus,
  palPick, parseSmartNl, purgeTrash, qInsert, qPick, qPickOwner, qPickPri, qRemoveToken, quickAddFromClipboard, restoreTrash, runForecast,
  saveDailyNoteText, saveIdea, saveOnePager, searchOpenContact, searchOpenDecision, searchOpenMeeting, searchOpenTask, setStatus,
  setListSort, setStatsRange, snoozeTask, stopTimerFlow, switchProject, toggleCardMenu, toggleDone, toggleFrog, toggleGanttCompare,
  toggleNotePreview, toggleOnePagerEditor, xwHeaderChanged, xwMapChanged, xwPickFile, xwSheetChanged, xwValueMap
});
Object.defineProperty(window, 'XW', { get: () => XW, configurable: true });
