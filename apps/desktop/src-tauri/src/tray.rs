use std::sync::atomic::Ordering;
use std::sync::PoisonError;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::commands;
use crate::conflict;
use crate::state::{self, MenuHandles};
use crate::window;

pub const TRAY_ID: &str = "atb-tray";

mod item {
  pub const HEADER: &str = "tray:header";
  pub const STATUS: &str = "tray:status";
  pub const OPEN_BOARD: &str = "tray:open-board";
  pub const COPY_MCP: &str = "tray:copy-mcp";
  pub const OPEN_LOGS: &str = "tray:open-logs";
  pub const RESTART: &str = "tray:restart";
  pub const QUIT: &str = "tray:quit";
}

/// 8.6 / 原型 2.3 的状态行：端口取 ATB_READY 回来的生效值，不是硬编码 7788。
/// 「运行中」的口径是 `Shared::service_up()`：进程活着**且**轮询读得通（10.4 的第三态）。
fn status_text(app: &AppHandle) -> String {
  let shared = state::shared(app);
  if shared.service_up() {
    format!("● 运行中 (端口 {})", shared.sidecar.port())
  } else {
    "● 服务已停止".to_string()
  }
}

fn tooltip(app: &AppHandle) -> String {
  let state_line = status_text(app);
  let plain = state_line.trim_start_matches('●').trim();
  format!("Jarvis Workbench · {plain}")
}

fn tray_image(error: bool) -> Option<Image<'static>> {
  let bytes: &[u8] = if error {
    include_bytes!("../icons/tray-icon-error.png")
  } else {
    include_bytes!("../icons/tray-icon.png")
  };
  Image::from_bytes(bytes).ok()
}

/// 托盘菜单（8.6 的六项 + 两行状态头）。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
  let shared = state::shared(app);
  // 头两项按原型是不可点的状态行（enabled = false）。
  let header = MenuItem::with_id(app, item::HEADER, "Jarvis Workbench", false, None::<&str>)?;
  let status = MenuItem::with_id(app, item::STATUS, status_text(app), false, None::<&str>)?;
  let open_board = MenuItem::with_id(app, item::OPEN_BOARD, "打开看板", true, None::<&str>)?;
  let copy_mcp = MenuItem::with_id(app, item::COPY_MCP, "复制 MCP 地址", true, None::<&str>)?;
  let open_logs = MenuItem::with_id(app, item::OPEN_LOGS, "查看日志", true, None::<&str>)?;
  let restart = MenuItem::with_id(app, item::RESTART, "重启服务", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, item::QUIT, "退出", true, None::<&str>)?;
  let gap_after_status = PredefinedMenuItem::separator(app)?;
  let gap_before_quit = PredefinedMenuItem::separator(app)?;

  let menu = Menu::with_items(
    app,
    &[
      &header,
      &status,
      &gap_after_status,
      &open_board,
      &copy_mcp,
      &open_logs,
      &restart,
      &gap_before_quit,
      &quit,
    ],
  )?;

  // `Menu` 没有 get_item，状态行以后要就地改文本 → 自己留句柄（MenuItem 是 Arc 句柄，共享同一原生项）。
  *shared
    .menu
    .lock()
    .unwrap_or_else(PoisonError::into_inner) = Some(MenuHandles {
    status,
    open_board,
    copy_mcp,
  });

  let mut builder = TrayIconBuilder::with_id(TRAY_ID)
    .menu(&menu)
    // 10.4：左键 = 打开看板，右键 = 菜单。
    .show_menu_on_left_click(false)
    .tooltip(tooltip(app))
    .on_menu_event(|app: &AppHandle, event| {
      on_menu_event(app, event.id().as_ref());
    })
    .on_tray_icon_event(|tray: &TrayIcon, event: TrayIconEvent| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        window::show_and_focus(tray.app_handle());
      }
    });
  if let Some(image) = tray_image(false) {
    builder = builder.icon(image).icon_as_template(true);
  }
  builder.build(app)?;
  Ok(())
}

fn on_menu_event(app: &AppHandle, id: &str) {
  match id {
    item::OPEN_BOARD => {
      window::show_and_focus(app);
    }
    item::COPY_MCP => {
      let shared = state::shared(app);
      let address = shared.sidecar.mcp_address();
      if commands::write_clipboard(&address).is_ok() {
        shared.log(&format!("托盘：已复制 MCP 地址 {address}"));
      } else {
        commands::error_dialog(
          app.clone(),
          "复制失败",
          format!("无法写入系统剪贴板，请手动复制：{address}"),
        );
      }
    }
    item::OPEN_LOGS => {
      commands::open_log_dir(app.clone());
    }
    item::RESTART => restart(app),
    item::QUIT => quit(app),
    _ => {}
  }
}

/// 原型 2.3：「重启服务」只重拉 sidecar，主窗口保持打开。
/// 放后台线程：`start()` 最坏要等满就绪超时，端口被占还要弹原生框问选择，两件都不能冻住主线程。
/// Token 不轮换——WebView 内存里已经是它，换了窗口就全 401
/// （9.4.1 的「每次启动随机」指应用启动，不是服务重启）。
fn restart(app: &AppHandle) {
  let shared = state::shared(app);
  shared.log("托盘：重启服务");
  shared.sidecar.stop();
  refresh(app);
  let handle = app.clone();
  std::thread::spawn(move || {
    conflict::restart_in_place(&handle, |app| {
      refresh(app);
      let shared = state::shared(app);
      state::publish_status(
        app,
        if shared.sidecar.is_running() {
          "running"
        } else {
          "stopped"
        },
      );
    });
  });
}

/// 9.4.1：只有托盘「退出」会结束 sidecar 并退出应用。
/// 原型 2.3 的「仍有执行中任务先弹确认」在前端那一侧（只有它知道 RUNNING 数），本期未接，见报告。
fn quit(app: &AppHandle) {
  let shared = state::shared(app);
  shared.quitting.store(true, Ordering::SeqCst);
  shared.log("托盘：退出（结束 sidecar）");
  shared.sidecar.stop();
  app.exit(0);
}

/// 运行中 / 已停止切换：状态行文本、图标配色（原型 2.3 三态）与可用性。
///
/// 这里是 10.4 那三态**唯一**的落地点：`sidecar::spawn_monitor`（进程挂了）与
/// `notify::poll_once`（进程活着但 HTTP 读不通）都只改自己那份事实、然后调本函数，
/// 谁都不自己碰图标。两边都只在「事实变了」时调，所以重复设同一个态是幂等的。
pub fn refresh(app: &AppHandle) {
  let shared = state::shared(app);
  let up = shared.service_up();
  let text = status_text(app);
  {
    let guard = shared.menu.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(handles) = guard.as_ref() {
      let _ = handles.status.set_text(&text);
      let _ = handles.open_board.set_enabled(up);
      let _ = handles.copy_mcp.set_enabled(up);
      // 「查看日志」在停止时更有用，所以不跟着禁用。
      // 托盘左键与 Dock 图标点击走的是 `on_tray_icon_event`，不受这里禁用影响：
      // 就算这一轮轮询把界面判成不可读，窗口照样点得开。
    }
  }
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    if let Some(image) = tray_image(!up) {
      // 正常态用 macOS template 图（随菜单栏深浅自动配色），错误态保留红色。
      // as_template 跟的是「这张图要不要自动配色」：正常态为 true；写反会让服务正常时
      // 固定用黑色源图，深色菜单栏/全屏下图标看不见。
      let _ = tray.set_icon_with_as_template(Some(image), up);
    }
    let _ = tray.set_tooltip(Some(tooltip(app)));
  }
}

/// 原型 2.3 / 10.4：macOS 走 dock 角标（`set_badge_count`），菜单栏图标标题同步（>99 → 99+）。
/// 数字来源现在是 `notify` 那条 30 秒轮询线程（窗口隐藏时 WebView 定时器会被节流）；
/// 前端 `tray_set_badge` 仍写同一个 `Shared::unread`，两处同源、不同时驱动。
/// Windows 的对应实现是覆盖图标 `set_overlay_icon`（需要 .ico，见报告「偏差」），本期未接。
pub fn set_badge(app: &AppHandle, count: u32) -> bool {
  let shared = state::shared(app);
  let title = if count == 0 {
    None
  } else {
    Some(shared.badge_text())
  };
  let mut ok = true;
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    ok = tray.set_title(title.clone()).is_ok();
  }
  // Windows 的对应实现是 set_overlay_icon（需要 .ico，见报告「偏差」）。
  #[cfg(target_os = "macos")]
  if let Some(main) = window::window(app) {
    let _ = main.set_badge_count(if count == 0 { None } else { Some(count as i64) });
  }
  ok
}
