#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod conflict;
mod diag;
mod notify;
mod paths;
mod sidecar;
mod state;
mod tray;
mod window;

use std::sync::Arc;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::state::Shared;

/// 端口定下来之后收尾（10.3 的时序要求）：建主窗口、刷托盘、发状态、起监控。
///
/// 只能从主线程调用——`window::create` 要在主线程建 WebView，而生效端口会被烧进
/// `initialization_script`（`window.rs`），所以必须在换端口/终止占用进程都尘埃落定之后才走到这里。
fn finish_boot(app: &AppHandle) {
  let shared = state::shared(app);
  let token = shared.token();
  let port = shared.sidecar.port();
  if let Err(error) = window::create(app, &token, port) {
    shared.log(&format!("主窗口创建失败：{error}"));
    app.exit(1);
    return;
  }
  tray::refresh(app);
  state::publish_status(
    app,
    if shared.sidecar.is_running() {
      "running"
    } else {
      "stopped"
    },
  );
  sidecar::spawn_monitor(app.clone());
}

/// 9.4.1 的启动时序：单实例锁（插件，build 阶段）→ 生成 Token → 建托盘 →
/// 后台线程拉起 sidecar（端口被占时按 10.3 问用户怎么办）→ 回主线程 `finish_boot` 建窗口。
fn main() {
  let data_dir = paths::data_dir();
  let logs_dir = paths::logs_dir();
  for dir in [&data_dir, &logs_dir] {
    if let Err(error) = paths::ensure_dir(dir) {
      eprintln!("[desktop] {error}");
    }
  }

  // sidecar 的 stdout/stderr 抄一份进 desktop.log：异常退出时这是唯一的现场。
  let sink_dir = logs_dir.clone();
  let sink: sidecar::OutputSink =
    Arc::new(move |line: &str| diag::append_line(&sink_dir, "desktop.log", "sidecar", line));

  let token = match sidecar::resolve_token() {
    Ok(token) => token,
    Err(error) => {
      eprintln!("[desktop] {error}");
      std::process::exit(1);
    }
  };
  let shared = Arc::new(Shared::new(
    data_dir.clone(),
    logs_dir.clone(),
    Arc::new(sidecar::Sidecar::new(paths::resolve_port(), sink)),
    token,
  ));

  let boot = shared.clone();
  let app = tauri::Builder::default()
    // 第 1 步：第二个实例在插件 setup 里就 process::exit，走不到下面的 sidecar 拉起（验收 31）。
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      // 已有实例：显示并聚焦它的主窗口后由调用方退出。
      window::show_and_focus(app);
    }))
    // 只在 Rust 侧用（原生保存框 + 启动失败提示），所以 capabilities 里不给 JS 授权。
    .plugin(tauri_plugin_dialog::init())
    .manage(shared.clone())
    .invoke_handler(tauri::generate_handler![
      commands::tray_set_badge,
      commands::open_external,
      commands::clipboard_write,
      commands::window_hide,
      commands::window_show,
      commands::open_log_dir,
      // 8.5「关于」/「备份」：版本与目录（system_info）、打开目录。
      commands::system_info,
      commands::open_dir,
      commands::save_text_file
    ])
    .setup(move |app| {
      let handle = app.handle().clone();
      let entry = sidecar::resolve_entry(app.path().resource_dir().ok().as_deref());
      boot.set_entry(entry.clone());
      boot.log(&format!(
        "启动：数据目录 {}，日志目录 {}，端口偏好 {}，命令 {}",
        boot.data_dir.display(),
        boot.logs_dir.display(),
        boot.sidecar.port(),
        entry.join(" ")
      ));

      // 第 5 步（建窗口）挪到了 `finish_boot`：端口可能被占，10.3 要弹原生框问用户换端口还是
      // 终止占用进程，而这一步和 `Sidecar::start` 都会阻塞主线程。托盘先建出来——
      // 用户把对话框关掉之后，至少还有「重启服务」可点。
      tray::build(&handle)?;
      tray::refresh(&handle);
      // 10.4 的未读数轮询：住在主进程，因为窗口一隐藏 WebView 定时器就被节流，
      // 角标会停在最后一次的值上。可以在 sidecar 就绪之前起——线程等的就是
      // 「没在跑 → 在跑」那个边沿，就绪即刻补第一轮，之后每 30 秒一轮。
      notify::spawn(handle.clone());
      let watch = handle.clone();
      std::thread::spawn(move || conflict::start_at_boot(&watch, finish_boot));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("构建 Jarvis Workbench 主进程失败：检查 apps/desktop/src-tauri/tauri.conf.json 与 apps/web/dist");

  app.run(move |app_handle, event| match event {
    // 2.1：关闭按钮 = 隐藏到托盘，窗口不销毁，sidecar 继续服务 Agent。
    RunEvent::WindowEvent {
      label,
      event: WindowEvent::CloseRequested { api, .. },
      ..
    } => {
      if label == window::LABEL {
        api.prevent_close();
        window::hide(app_handle);
      }
    }
    // 位置记忆（原型 2.1）：尺寸与位置都要留档，写盘有 200ms 去抖。
    RunEvent::WindowEvent {
      label,
      event: WindowEvent::Resized(_) | WindowEvent::Moved(_),
      ..
    } => {
      if label == window::LABEL {
        window::persist(app_handle, false);
      }
    }
    #[cfg(target_os = "macos")]
    // 2.1：macOS Dock 图标点击 → 显示并聚焦主窗口。
    RunEvent::Reopen { .. } => {
      window::show_and_focus(app_handle);
    }
    // 7.4：无论走托盘「退出」还是 Cmd+Q，离开进程前都必须收掉 sidecar，不留孤儿。
    RunEvent::Exit => {
      let shared = state::shared(app_handle);
      if shared.sidecar.stop().is_some() {
        shared.log("退出：结束 sidecar");
      }
    }
    _ => {}
  });
}
