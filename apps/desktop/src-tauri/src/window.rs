use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::paths;
use crate::state;

/// 原型 2.1 的窗口规格：1440×900 起、960×600 止、原生标题栏、标题固定。
pub const LABEL: &str = "main";
pub const TITLE: &str = "Jarvis Workbench";
pub const DEFAULT_WIDTH: f64 = 1440.0;
pub const DEFAULT_HEIGHT: f64 = 900.0;
pub const MIN_WIDTH: f64 = 960.0;
pub const MIN_HEIGHT: f64 = 600.0;

/// 记住上次尺寸与位置（原型 2.1「位置记忆」+ 16 章 24 条）。
/// 存 `<dataDir>/window-state.json`：不进 sidecar 的 `settings` 表，也不进备份（20.9）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowState {
  pub width: f64,
  pub height: f64,
  pub x: f64,
  pub y: f64,
  pub maximized: bool,
}

fn load_state(file: &Path) -> Option<WindowState> {
  let raw = fs::read_to_string(file).ok()?;
  let parsed: WindowState = serde_json::from_str(&raw).ok()?;
  // 低于最小尺寸的脏数据（改了 2.1 规格或手改过文件）直接丢弃，用默认值。
  if parsed.width < MIN_WIDTH || parsed.height < MIN_HEIGHT {
    return None;
  }
  Some(parsed)
}

fn save_state(file: &Path, snapshot: &WindowState) -> Result<(), String> {
  let body = serde_json::to_string_pretty(snapshot).map_err(|error| error.to_string())?;
  let tmp = file.with_extension("json.tmp");
  fs::write(&tmp, body).map_err(|error| format!("写 {} 失败：{error}", tmp.display()))?;
  paths::restrict_to_owner(&tmp);
  fs::rename(&tmp, file).map_err(|error| format!("改名到 {} 失败：{error}", file.display()))
}

/// 保存点是否已经“稳定”：拖拽/缩放期间每帧都来事件，200ms 内不重复写盘。
fn should_write(app: &AppHandle, force: bool) -> bool {
  let shared = state::shared(app);
  let mut guard = shared
    .last_state_write
    .lock()
    .unwrap_or_else(std::sync::PoisonError::into_inner);
  if !force && guard.map(|last| last.elapsed() < Duration::from_millis(200)).unwrap_or(false) {
    return false;
  }
  *guard = Some(Instant::now());
  true
}

/// 上次记忆的左上角是否还在某个显示器上（拔了外接屏就不该把窗口扔进虚空）。
fn position_reachable(app: &AppHandle, x: f64, y: f64) -> bool {
  let Ok(monitors) = app.available_monitors() else {
    return true;
  };
  if monitors.is_empty() {
    return true;
  }
  monitors.iter().any(|monitor| {
    let scale = monitor.scale_factor().max(1.0);
    let position = monitor.position();
    let size = monitor.size();
    let left = position.x as f64 / scale;
    let top = position.y as f64 / scale;
    let right = (position.x + size.width as i32) as f64 / scale;
    let bottom = (position.y + size.height as i32) as f64 / scale;
    // 至少留 80×28 的标题栏可见，才能被拖回来。
    x > left - 80.0 && x < right - 80.0 && y >= top - 4.0 && y < bottom - 28.0
  })
}

/// 9.4.1 第 5 步：主窗口创建时才把 Token 与端口注入 WebView。
///
/// 值走 `serde_json` 序列化，引号/反斜杠由它负责转义；Token 只出现在这一条字符串里，
/// 不落盘、不进 `tauri.conf.json`。
pub fn injection_script(token: &str, port: u16) -> String {
  let token_literal = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
  let base_literal =
    serde_json::to_string(&format!("http://127.0.0.1:{port}")).unwrap_or_else(|_| "\"\"".to_string());
  format!(
    "window.__ATB_UI_TOKEN__={token_literal};window.__ATB_PORT__={port};window.__ATB_API_BASE__={base_literal};"
  )
}

pub fn create(app: &AppHandle, token: &str, port: u16) -> tauri::Result<WebviewWindow> {
  let saved = load_state(&paths::window_state_file()).filter(|state| position_reachable(app, state.x, state.y));
  let (width, height) = saved
    .as_ref()
    .map(|state| (state.width, state.height))
    .unwrap_or((DEFAULT_WIDTH, DEFAULT_HEIGHT));

  let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
    .title(TITLE)
    .decorations(true)
    .resizable(true)
    .maximizable(true)
    .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
    .inner_size(width, height)
    .visible(true)
    .focused(true)
    .initialization_script(&injection_script(token, port));

  match saved.as_ref() {
    Some(state) => {
      builder = builder.position(state.x, state.y);
      if state.maximized {
        builder = builder.maximized(true);
      }
    }
    None => builder = builder.center(),
  }
  builder.build()
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
  app.get_webview_window(LABEL)
}

/// 托盘「打开看板」/ Dock 图标点击 / 二次启动：显示并聚焦，不重置视图（8.6、2.1）。
pub fn show_and_focus(app: &AppHandle) -> bool {
  let Some(window) = window(app) else {
    return false;
  };
  let _ = window.unminimize();
  let shown = window.show().is_ok();
  let _ = window.set_focus();
  shown
}

/// 2.1：关闭按钮 = 隐藏到托盘，窗口不销毁，sidecar 继续跑。
pub fn hide(app: &AppHandle) -> bool {
  let Some(window) = window(app) else {
    return false;
  };
  persist(app, true);
  window.hide().is_ok()
}

/// 把当前尺寸/位置写回 window-state.json。
pub fn persist(app: &AppHandle, force: bool) {
  if !should_write(app, force) {
    return;
  }
  let Some(window) = window(app) else {
    return;
  };
  let shared = state::shared(app);
  let scale = window.scale_factor().unwrap_or(1.0).max(1.0);
  let size = window.inner_size().unwrap_or(tauri::PhysicalSize::new(
    (DEFAULT_WIDTH * scale) as u32,
    (DEFAULT_HEIGHT * scale) as u32,
  ));
  let position = window
    .outer_position()
    .unwrap_or(tauri::PhysicalPosition::new((scale * 80.0) as i32, (scale * 80.0) as i32));
  let state = WindowState {
    width: size.width as f64 / scale,
    height: size.height as f64 / scale,
    x: position.x as f64 / scale,
    y: position.y as f64 / scale,
    maximized: window.is_maximized().unwrap_or(false),
  };
  let file = paths::window_state_file();
  if let Some(parent) = file.parent() {
    let _ = paths::ensure_dir(parent);
  }
  if let Err(error) = save_state(&file, &state) {
    shared.log(&format!("窗口记忆写入失败：{error}"));
  }
}
