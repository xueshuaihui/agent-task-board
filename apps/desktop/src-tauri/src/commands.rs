use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::paths;
use crate::state;
use crate::tray;
use crate::window;

/// 15 章：只有 http/https 才允许交系统默认浏览器。
/// `file://`、`javascript:`、自定义 scheme（如 `cursor://`）一律拒绝——WebView 不导航，主进程也不 exec。
fn is_web_url(raw: &str) -> bool {
  match tauri::Url::parse(raw.trim()) {
    Ok(url) => matches!(url.scheme(), "http" | "https"),
    Err(_) => false,
  }
}

/// 交系统打开：URL → 默认浏览器，目录 → 文件管理器（2.3「查看日志」）。
fn shell_open(target: &str) -> Result<(), String> {
  let spawned = if cfg!(target_os = "macos") {
    let mut command = Command::new("open");
    command.arg(target);
    command.spawn()
  } else if cfg!(target_os = "windows") {
    // `start` 是 cmd 内建命令；第一个空串是它的 title 占位参数。
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", target]);
    command.spawn()
  } else {
    let mut command = Command::new("xdg-open");
    command.arg(target);
    command.spawn()
  };
  spawned
    .map(|_| ())
    .map_err(|error| format!("打开失败：{error}"))
}

pub(crate) fn write_clipboard(text: &str) -> Result<(), String> {
  let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
  clipboard
    .set_text(text.to_string())
    .map_err(|error| error.to_string())
}

/// 导出建议文件名：只取 file_name，路径穿越（`../../etc/passwd`）在这里被削掉。
fn suggested_name(raw: &str) -> String {
  let fallback = "atb-export.json";
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return fallback.to_string();
  }
  Path::new(trimmed)
    .file_name()
    .map(|value| value.to_string_lossy().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| fallback.to_string())
}

/// 主进程没实测到的值一律给 `None` → JSON `null` → 前端显示 `—`（原型 7.9：
/// 这一页的存在就是为了说清「我连的是谁」，编一个版本号比空着更糟）。
fn measured(raw: &str) -> Option<String> {
  let trimmed = raw.trim();
  (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `open_dir { target }` 的四枚枚举值（8.5「关于」+ 原型 7.9 的四行目录）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirTarget {
  Data,
  Artifacts,
  Logs,
  Backups,
}

impl DirTarget {
  /// 只认这四个词：实际路径全部由主进程按 `Shared::data_dir` 派生，
  /// WebView 传进来的字符串**永远不当作路径使用**——否则
  /// `open_dir { target: '/etc' }` 就是一次任意目录打开。
  fn parse(raw: &str) -> Option<Self> {
    match raw.trim() {
      "data" => Some(Self::Data),
      "artifacts" => Some(Self::Artifacts),
      "logs" => Some(Self::Logs),
      "backups" => Some(Self::Backups),
      _ => None,
    }
  }

  /// 数据/日志目录直接用主进程启动时算好的那份，产物与备份按同一份数据目录派生
  /// （sidecar 的 `ATB_DATA_DIR` 就是我们注入的，见 `sidecar::start`）。
  fn resolve(self, shared: &state::Shared) -> PathBuf {
    match self {
      Self::Data => shared.data_dir.clone(),
      Self::Artifacts => paths::artifacts_dir(&shared.data_dir),
      Self::Logs => shared.logs_dir.clone(),
      Self::Backups => paths::backups_dir(&shared.data_dir),
    }
  }
}

/// `system_info` 的载荷（8.5「关于」）。字段名就是前端 `SystemInfo` 那几个 snake_case 键——
/// 前端不做 camelCase 转换，改名要两边一起改（13 章无对应 REST 端点，只能走 IPC）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SystemInfo {
  pub app_version: Option<String>,
  pub sidecar_version: Option<String>,
  /// sidecar 进程是否还活着（原型 7.9「服务状态」一行的实测来源）。
  pub sidecar_alive: bool,
  /// 当前 pid：0 = 没起过。异常退出后前端要靠它区分「没起」和「起过又挂了」。
  pub pid: u32,
  pub port: u16,
  pub data_dir: String,
  pub artifacts_dir: String,
  pub logs_dir: String,
  pub backup_dir: String,
  /// 路径全部来自主进程实测，不是前端那套平台约定值（前端据此去掉「按约定值」标注）。
  pub dirs_from_convention: bool,
}

/// 快照：版本号来自 tauri 配置与 `ATB_READY` 行，端口/pid 取自 sidecar 的生效值，
/// 四个目录取自 `Shared`。不读环境、不碰磁盘，所以可以在没有显示器的环境里直接测。
fn system_info_snapshot(app_version: &str, shared: &state::Shared) -> SystemInfo {
  SystemInfo {
    app_version: measured(app_version),
    sidecar_version: measured(&shared.sidecar.version()),
    sidecar_alive: shared.sidecar.is_running(),
    pid: shared.sidecar.pid(),
    port: shared.sidecar.port(),
    data_dir: shared.data_dir.display().to_string(),
    artifacts_dir: paths::artifacts_dir(&shared.data_dir).display().to_string(),
    logs_dir: shared.logs_dir.display().to_string(),
    backup_dir: paths::backups_dir(&shared.data_dir).display().to_string(),
    dirs_from_convention: false,
  }
}

/// 原型 2.3 / 10.4：角标数字现在由主进程那条 30 秒轮询线程供给（`notify::poll_once`，
/// 窗口隐藏时 WebView 定时器会被节流，所以不经前端）。这个命令保留：前端铃铛与托盘同源，
/// 谁要是有更准的即时数字（例如刚点开一条通知），写的是同一个 `Shared::unread`。
/// 返回布尔而不是 Err——`desktop.ts` 的 `call()` 一旦 reject，界面就是一次未捕获异常。
#[tauri::command]
pub fn tray_set_badge(app: AppHandle, count: u32) -> bool {
  let shared = state::shared(&app);
  shared.unread.store(count, Ordering::Relaxed);
  tray::set_badge(&app, count)
}

/// 15 章：`link` 产物、PR 链接交系统浏览器，WebView 内不导航。
#[tauri::command]
pub fn open_external(url: String) -> bool {
  if !is_web_url(&url) {
    eprintln!("[desktop] open_external 拒绝非 http/https 目标");
    return false;
  }
  match shell_open(url.trim()) {
    Ok(()) => true,
    Err(error) => {
      eprintln!("[desktop] {error}");
      false
    }
  }
}

/// 6.5、2.3：MCP 地址、Token 值等复制。
#[tauri::command]
pub fn clipboard_write(text: String) -> bool {
  match write_clipboard(&text) {
    Ok(()) => true,
    Err(error) => {
      eprintln!("[desktop] clipboard_write 失败：{error}");
      false
    }
  }
}

#[tauri::command]
pub fn window_hide(app: AppHandle) -> bool {
  window::hide(&app)
}

#[tauri::command]
pub fn window_show(app: AppHandle) -> bool {
  window::show_and_focus(&app)
}

/// 2.3「查看日志」：日志目录与 sidecar 同源（paths::logs_dir）；没起过 sidecar 时先建目录，
/// 否则 `open` 会对着一个不存在的路径报错。
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> bool {
  open_dir_of(&app, DirTarget::Logs)
}

/// 把一个已解析好的目录交系统文件管理器打开（`open` / `explorer` / `xdg-open`，
/// 与 `open_external` 同一条 `shell_open` 路径，不需要额外依赖）。
/// 同样返回布尔而不是 Err：`desktop.ts` 的 `call()` 一旦 reject 就是一次未捕获异常。
fn open_dir_of(app: &AppHandle, kind: DirTarget) -> bool {
  let shared = state::shared(app);
  let dir = kind.resolve(&shared);
  // 产物与备份目录可能一次都没写过（sidecar 只在 bootstrap 里建），先 ensure 再打开。
  if let Err(error) = paths::ensure_dir(&dir) {
    shared.log(&format!("open_dir({kind:?})：{error}"));
    return false;
  }
  match shell_open(&dir.display().to_string()) {
    Ok(()) => true,
    Err(error) => {
      shared.log(&format!("open_dir({kind:?})：{error}"));
      false
    }
  }
}

/// 8.5「关于」/ 原型 7.9：版本号、生效端口与四个目录的一次性只读快照。
/// 13 章没有任何返回这些的 REST 端点（端口按 10.3 也不进 `settings`），
/// 所以这份数据只能由主进程给——它才是持有 `ATB_READY` 与 `ATB_DATA_DIR` 的那一方。
#[tauri::command]
pub fn system_info(app: AppHandle) -> SystemInfo {
  let shared = state::shared(&app);
  system_info_snapshot(&app.package_info().version.to_string(), &shared)
}

/// 「打开目录」：`target` 只接受 `data` / `artifacts` / `logs` / `backups` 四个枚举值，
/// 路径由主进程自己派生（见 `DirTarget::parse` 的注释）。
#[tauri::command]
pub fn open_dir(app: AppHandle, target: String) -> bool {
  match DirTarget::parse(&target) {
    Some(kind) => open_dir_of(&app, kind),
    None => {
      state::shared(&app).log(&format!("open_dir：拒绝未知 target {target:?}"));
      false
    }
  }
}

/// 6.12.1 导出：原生保存对话框。返回落盘路径；用户取消或写入失败返回空串
/// （不是 null——前端 `saved === null` 会再走一次 `<a download>`，等于存两遍）。
#[tauri::command]
pub async fn save_text_file(app: AppHandle, filename: String, contents: String) -> String {
  let task = tauri::async_runtime::spawn_blocking(move || save_blocking(&app, &filename, &contents));
  match task.await {
    Ok(path) => path,
    Err(error) => {
      eprintln!("[desktop] save_text_file 任务失败：{error}");
      String::new()
    }
  }
}

/// `blocking_save_file` 内部会跳主线程等结果，所以只能跑在非主线程上（这里由 spawn_blocking 保证）。
fn save_blocking(app: &AppHandle, filename: &str, contents: &str) -> String {
  let shared = state::shared(app);
  let name = suggested_name(filename);
  let Some(picked) = app
    .dialog()
    .file()
    .set_title("导出文件")
    .set_file_name(&name)
    // 17.2：CSV 双向是阶段二，阶段一的入口「不显示，而不是点了报错」——所以这里只留 JSON。
    // 前端同理（`SHOW_CSV_EXPORT=false` 时那一行整体不渲染），两侧都得摆着同一个口径。
    .add_filter("JSON", &["json"])
    .blocking_save_file()
  else {
    return String::new();
  };
  let Ok(path) = picked.into_path() else {
    shared.log("save_text_file：拿不到本地文件路径（非文件 URI）");
    return String::new();
  };
  match std::fs::write(&path, contents) {
    Ok(()) => {
      shared.log(&format!("导出已写入 {}", path.display()));
      path.display().to_string()
    }
    Err(error) => {
      let message = format!("写入 {} 失败：{error}", path.display());
      shared.log(&message);
      app
        .dialog()
        .message(message)
        .title("导出失败")
        .kind(MessageDialogKind::Error)
        .blocking_show();
      String::new()
    }
  }
}

/// 启动阶段（主窗口尚未创建）的失败提示：10.3 要求用原生对话框，不静默退出。
/// 同样必须离开主线程——`blocking_show` 会跳主线程等结果。
pub fn error_dialog(app: AppHandle, title: &str, message: String) {
  show_message_dialog(app, title, message, MessageDialogKind::Error);
}

/// 同 [`error_dialog`]，但只是「做完了，告诉你一声」（10.3 换端口成功后的提醒）。
pub fn notice_dialog(app: AppHandle, title: &str, message: String) {
  show_message_dialog(app, title, message, MessageDialogKind::Info);
}

fn show_message_dialog(app: AppHandle, title: &str, message: String, kind: MessageDialogKind) {
  let title = title.to_string();
  let app_clone = app.clone();
  std::thread::spawn(move || {
    let _ = app_clone
      .dialog()
      .message(message)
      .title(title)
      .kind(kind)
      .blocking_show();
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sidecar::{OutputSink, Sidecar};
  use std::sync::Arc;

  /// 不建窗口、不拉进程：只要一份 `Shared`，端口就是主进程偏好端口（没读到 ATB_READY 的样子）。
  fn shared(data_dir: &str, logs_dir: &str, port: u16) -> state::Shared {
    let sink: OutputSink = Arc::new(|_| {});
    state::Shared::new(
      PathBuf::from(data_dir),
      PathBuf::from(logs_dir),
      Arc::new(Sidecar::new(port, sink)),
      "0123456789abcdef0123456789abcdef".to_string(),
    )
  }

  #[test]
  fn dir_target_accepts_only_the_four_enum_values() {
    assert_eq!(DirTarget::parse("data"), Some(DirTarget::Data));
    assert_eq!(DirTarget::parse(" artifacts "), Some(DirTarget::Artifacts));
    assert_eq!(DirTarget::parse("logs"), Some(DirTarget::Logs));
    assert_eq!(DirTarget::parse("backups"), Some(DirTarget::Backups));
    // WebView 不能指定要打开哪个目录：绝对路径、穿越片段、大小写变体一律拒绝。
    assert_eq!(DirTarget::parse("/etc"), None);
    assert_eq!(DirTarget::parse("../../secrets"), None);
    assert_eq!(DirTarget::parse("DATA"), None);
    assert_eq!(DirTarget::parse(""), None);
  }

  #[test]
  fn dirs_derive_from_the_shared_data_dir() {
    let shared = shared("/tmp/atb-data", "/tmp/atb-logs", 7788);
    assert_eq!(
      DirTarget::Data.resolve(&shared),
      PathBuf::from("/tmp/atb-data")
    );
    assert_eq!(
      DirTarget::Logs.resolve(&shared),
      PathBuf::from("/tmp/atb-logs")
    );
    assert_eq!(
      DirTarget::Artifacts.resolve(&shared),
      PathBuf::from("/tmp/atb-data/artifacts")
    );
    assert_eq!(
      DirTarget::Backups.resolve(&shared),
      PathBuf::from("/tmp/atb-data/backups")
    );
  }

  #[test]
  fn snapshot_carries_the_snake_case_keys_the_frontend_types() {
    let shared = shared("/tmp/atb-data", "/tmp/atb-logs", 7899);
    let value = serde_json::to_value(system_info_snapshot("0.1.0", &shared)).expect("序列化");
    let object = value.as_object().expect("载荷应为对象");
    for key in [
      "app_version",
      "sidecar_version",
      "sidecar_alive",
      "pid",
      "port",
      "data_dir",
      "artifacts_dir",
      "logs_dir",
      "backup_dir",
      "dirs_from_convention",
    ] {
      assert!(object.contains_key(key), "缺键 {key}");
    }
    assert_eq!(object["app_version"], serde_json::json!("0.1.0"));
    assert_eq!(object["port"], serde_json::json!(7899));
    assert_eq!(
      object["backup_dir"],
      serde_json::json!("/tmp/atb-data/backups")
    );
    // 主进程给的路径都是实测值，前端据此撤掉「按约定值」标注。
    assert_eq!(object["dirs_from_convention"], serde_json::json!(false));
  }

  #[test]
  fn unmeasured_versions_serialize_as_null_so_the_ui_shows_dash() {
    // 没读到 ATB_READY（或 sidecar 起来了又挂了）：版本为空串 → null，而不是编一个版本号。
    let shared = shared("/tmp/atb-data", "/tmp/atb-logs", 7788);
    let snapshot = system_info_snapshot("  ", &shared);
    assert_eq!(snapshot.app_version, None);
    assert_eq!(snapshot.sidecar_version, None);
    assert!(!snapshot.sidecar_alive);
    assert_eq!(snapshot.pid, 0);
    let body = serde_json::to_string(&snapshot).expect("序列化");
    assert!(body.contains(r#""sidecar_version":null"#), "{body}");
    assert_eq!(measured(" 0.1.0 "), Some("0.1.0".to_string()));
  }
}
