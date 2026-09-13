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
