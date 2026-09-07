/* ---------- 全局托管状态 ---------- */

use rusqlite::Connection;
use std::sync::Mutex;

/// 全局 SQLite 连接：单 Mutex 串行化读写（桌面单用户应用足够）
pub struct Db(pub Mutex<Connection>);

/// 窗口大小/位置保存的节流器：Resized/Moved 事件每秒最多落盘一次
pub struct WinSaveGuard(pub Mutex<std::time::Instant>);
