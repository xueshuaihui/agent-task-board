use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::diag;
use crate::sidecar::Sidecar;

/// 主进程的全部可变状态。`Arc<Shared>` 由 tauri 托管，线程侧用 `shared(&app)` 取克隆。
pub struct Shared {
  pub data_dir: PathBuf,
  pub logs_dir: PathBuf,
  pub sidecar: Arc<Sidecar>,
  /// UI 会话 Token：只存内存（9.4.1 第 2 步）。不落盘、不进日志、不进命令行参数。
  pub token: Mutex<String>,
  /// 实际使用的 sidecar 启动命令（「重启服务」复用，避免运行期解析漂移）。
  pub entry: Mutex<Vec<String>>,
  /// 只有托盘「退出」会置真：它决定 sidecar 退出是不是「异常」（7.4）。
  pub quitting: AtomicBool,
  /// 未读通知数：与顶栏铃铛同源，前端用 `tray_set_badge` 推过来（原型 2.3）。
  pub unread: AtomicU32,
  /// 轮询线程的「连不上」判词（10.4）：进程还活着但 HTTP 读不通时，托盘仍应呈现
  /// 「服务已停止」，因为对用户来说那正是同一个故障。
  ///
  /// 它只是 `Sidecar::running` 之上的一层呈现修正，不是第二份状态机：进程真实状态
  /// 仍以 `Sidecar::running` 为准（`system_info` 报的是它），改判词只走
  /// [`Shared::set_service_unreachable`]，其返回值（是否变化）就是幂等刷托盘的依据。
  pub unreachable: AtomicBool,
  /// 托盘菜单首项（状态行）与「服务已停止」时要禁用的项。
  pub menu: Mutex<Option<MenuHandles>>,
  /// 窗口记忆写盘去抖：拖拽/缩放时不要每帧都写文件。
  pub last_state_write: Mutex<Option<std::time::Instant>>,
}

/// 菜单项句柄（`Menu::get` 拿不到，就自己留一份）：只留运行期真的会改的那些。
pub struct MenuHandles {
  pub status: tauri::menu::MenuItem<tauri::Wry>,
  pub open_board: tauri::menu::MenuItem<tauri::Wry>,
  pub copy_mcp: tauri::menu::MenuItem<tauri::Wry>,
}

impl Shared {
  pub fn new(data_dir: PathBuf, logs_dir: PathBuf, sidecar: Arc<Sidecar>, token: String) -> Self {
    Self {
      data_dir,
      logs_dir,
      sidecar,
      token: Mutex::new(token),
      entry: Mutex::new(Vec::new()),
      quitting: AtomicBool::new(false),
      unread: AtomicU32::new(0),
      unreachable: AtomicBool::new(false),
      menu: Mutex::new(None),
      last_state_write: Mutex::new(None),
    }
  }

  pub fn token(&self) -> String {
    self
      .token
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .clone()
  }

  pub fn entry(&self) -> Vec<String> {
    self
      .entry
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .clone()
  }

  pub fn set_entry(&self, entry: Vec<String>) {
    *self
      .entry
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner) = entry;
  }

  pub fn log(&self, message: &str) {
    diag::append_line(&self.logs_dir, "desktop.log", "desktop", message);
  }

  /// 角标文本：`>99` 显示 `99+`（原型 2.3）。
  pub fn badge_text(&self) -> String {
    let count = self.unread.load(Ordering::Relaxed);
    if count > 99 {
      "99+".to_string()
    } else {
      count.to_string()
    }
  }

  /// 改「连不上」判词，返回**是否真的变了**。
  ///
  /// 返回值就是幂等保证：调用方只在 `true` 时去 `tray::refresh`，所以连续失败 N 轮、
  /// 或恢复后又成功 N 轮，都只各动一次图标——不与 2 秒一轮的 `sidecar::spawn_monitor`
  /// 抢着反复设同一个态（10.4）。
  pub fn set_service_unreachable(&self, value: bool) -> bool {
    self.unreachable.swap(value, Ordering::Relaxed) != value
  }

  /// 托盘呈现意义上的「服务可用」：进程活着（`Sidecar::running`）且轮询没判它读不通。
  /// 状态行文本、图标配色、菜单项可用性三处都从这里取，所以 10.4 的三态只有一处推导。
  ///
  /// 注意 `commands::system_info` 刻意**不**用这个值：「关于」页那行「服务状态」要回答的是
  /// 「进程还在不在」，那是实测事实；这里回答的是「托盘该不该红」，那是呈现口径。两者混在
  /// 一处就会把一个 2 秒的网络抖动说成进程死了。
  pub fn service_up(&self) -> bool {
    self.sidecar.is_running() && !self.unreachable.load(Ordering::Relaxed)
  }
}

pub fn shared(app: &AppHandle) -> Arc<Shared> {
  app.state::<Arc<Shared>>().inner().clone()
}

pub fn quitting(app: &AppHandle) -> bool {
  shared(app).quitting.load(Ordering::Relaxed)
}

#[derive(Serialize, Clone)]
pub struct StatusPayload {
  /// `running` | `stopped`
  pub status: &'static str,
  pub running: bool,
  pub port: u16,
  pub pid: u32,
  pub version: String,
}

/// 主进程 → WebView 的状态事件（9.4.2 的「invoke + 事件」）。
/// 前端目前没订阅，接不接由 ATB-5 之后决定；托盘与主进程自身都靠它保持状态一致。
pub fn publish_status(app: &AppHandle, status: &'static str) {
  let shared = shared(app);
  let payload = StatusPayload {
    status,
    running: shared.sidecar.is_running(),
    port: shared.sidecar.port(),
    pid: shared.sidecar.pid(),
    version: shared.sidecar.version(),
  };
  let _ = app.emit("atb://sidecar-status", payload);
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sidecar::{OutputSink, Sidecar};
  use std::path::PathBuf;

  fn shared(running: bool) -> Shared {
    let sink: OutputSink = Arc::new(|_| {});
    let sidecar = Arc::new(Sidecar::new(7788, sink));
    sidecar.set_running_for_test(running);
    Shared::new(
      PathBuf::from("/tmp/atb-data"),
      PathBuf::from("/tmp/atb-logs"),
      sidecar,
      "0123456789abcdef0123456789abcdef".to_string(),
    )
  }

  /// 10.4 的三态推导只有一处：进程状态 ×（可选的）轮询判词。
  #[test]
  fn service_up_follows_the_process_and_the_poll_verdict() {
    let down = shared(false);
    assert!(!down.service_up(), "进程没起来就是停了");
    // 进程都没起来时，判词不该把状态翻成「可用」——它只做减法。
    assert!(!down.set_service_unreachable(false));
    assert!(!down.service_up());

    let up = shared(true);
    assert!(up.service_up());
    assert!(up.set_service_unreachable(true), "首次判不可达应报出变化");
    assert!(!up.service_up(), "进程活着但读不通 → 托盘呈现「服务已停止」");
    assert!(up.set_service_unreachable(false), "恢复应报出变化");
    assert!(up.service_up());
  }

  /// 重复设同一个态必须是 no-op：轮询 30 秒一轮，监控线程 2 秒一轮，谁都不该被反复刷。
  #[test]
  fn the_same_verdict_twice_changes_nothing() {
    let shared = shared(true);
    assert!(shared.set_service_unreachable(true));
    assert!(!shared.set_service_unreachable(true), "重复判失败不该再刷一次托盘");
    assert!(shared.set_service_unreachable(false));
    assert!(!shared.set_service_unreachable(false), "重复判恢复同理");
  }

  #[test]
  fn badge_text_caps_at_99_plus() {
    let shared = shared(true);
    shared.unread.store(0, Ordering::Relaxed);
    assert_eq!(shared.badge_text(), "0");
    shared.unread.store(7, Ordering::Relaxed);
    assert_eq!(shared.badge_text(), "7");
    shared.unread.store(100, Ordering::Relaxed);
    assert_eq!(shared.badge_text(), "99+");
  }
}
