/* ---------- 数据模型（与前端 JSON 一一对应，serde camelCase） ---------- */

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub archived: bool,
    pub created_at: String,
    pub settings_json: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub due: String,
    pub owner: String,
    pub pri: String,
    pub status: String,
    pub done_at: String,
    pub risk: bool,
    pub repeat: String,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i64,
    pub checklist_json: String,
    pub defer_count: i64,
    pub risk_prob: i64,
    pub risk_impact: i64,
    pub risk_mitigate: String,
    pub risk_escalate: String,
    pub doing_since: String,
    pub parent_id: i64,
    pub start_date: String,
    pub is_milestone: bool,
    /* 单次提醒（★★★）：YYYY-MM-DD HH:MM，到点弹系统通知后清空 */
    pub remind_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Idea {
    pub id: i64,
    pub title: String,
    pub note: String,
    pub value: i64,
    pub effort: i64,
    pub converted: i64,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TimeLog {
    pub id: i64,
    pub task_id: i64,
    pub project_id: i64,
    pub date: String,
    pub minutes: i64,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DeletedItem {
    pub id: i64,
    pub kind: String,
    pub payload: String,
    pub summary: String,
    pub deleted_at: String,
}

/* ---------- 包3：决策日志（ADR 模板：背景/选项/决定/原因） ---------- */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Decision {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub background: String,
    pub options: String,
    pub decision: String,
    pub reason: String,
    pub date: String,
    pub status: String,
    pub task_id: i64,
    pub meeting_id: i64,
    pub created_at: String,
}

/* ---------- 包3：会议记录（含行动项，Fellow 模式） ---------- */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Meeting {
    pub id: i64,
    pub date: String,
    pub title: String,
    pub attendees: String,
    pub conclusion: String,
    pub project_id: i64,
    pub items_json: String,
    pub created_at: String,
}

/* ---------- 包3：干系人（FollowUpThen 机制：上次沟通 + 周期 → 到期生成跟进任务） ---------- */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Contact {
    pub id: i64,
    pub name: String,
    pub org: String,
    pub tags: String,
    pub projects: String,
    pub note: String,
    pub last_contact: String,
    pub followup_days: i64,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppData {
    pub projects: Vec<Project>,
    pub tasks: Vec<Task>,
    pub ideas: Vec<Idea>,
    pub time_logs: Vec<TimeLog>,
    pub decisions: Vec<Decision>,
    pub meetings: Vec<Meeting>,
    pub contacts: Vec<Contact>,
}


