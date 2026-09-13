//! 10.3「端口占用处理」：端口被占时不静默退出，也不让用户去翻环境变量——
//! 给出两个出路：**换个端口启动**（生效端口写回 `config.json`）或**终止占用进程**后按原端口重试。
//!
//! 三条硬约束决定了这里的形状：
//! 1. 要拿到用户的选择，而 `Sidecar::start` 最坏会等满就绪超时，所以整条流程必须离开主线程；
//!    主窗口的 `initialization_script` 里烧着生效端口（`window.rs`），换过端口就得用新端口重建，
//!    因此**窗口只能在端口定下来之后创建**——这就是 `done` 回调存在的原因，也解释它为何回主线程。
//! 2. 终止占用进程 = 杀别人家的进程：只认监听该端口的那一个 pid，说不出它是谁就不提供这个选项。
//! 3. 放弃处理不是失败退出：窗口照样建，界面显示「本地服务未运行」，托盘还有「重启服务」。

use std::process::Command;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::commands;
use crate::paths;
use crate::sidecar;
use crate::state;

/// 换端口时从「偏好端口 + 1」往上找，最多试这么多格；再找不到就是机器不正常，别硬试。
const PORT_SCAN_SPAN: u16 = 20;

/// 自定义按钮的文案。桌面端 rfd 会把它们映射成 [`MessageDialogResult::Custom`]，
/// 所以判定只能比字符串——常量收在这里，别散进 match。
const SWITCH: &str = "换个端口启动";
const KILL: &str = "终止占用进程";
const SKIP: &str = "先不处理";

/// 端口被占时的出路。
#[derive(Debug, PartialEq, Eq)]
pub enum Choice {
  /// 找一个空闲端口启动，并把生效端口写回 `config.json`。
  Switch,
  /// 杀掉监听该端口的进程，按原端口重试。
  Kill,
  /// 用户放弃：sidecar 不起，窗口照建。
  Skip,
}

/// 哪个进程占着端口。`name` 拿不到时是「未知进程」，此时不提供 [`Choice::Kill`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occupant {
  pub pid: u32,
  pub name: String,
}

/// 纯解析：`lsof -t` 每行一个 pid。混进警告或表头就跳过那行，而不是整批作废。
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn parse_pids(text: &str) -> Vec<u32> {
  text
    .lines()
    .filter_map(|line| line.trim().parse::<u32>().ok())
    .collect()
}

/// 纯解析：`netstat -ano` 的 `TCP  127.0.0.1:7788  0.0.0.0:0  LISTENING  4321`。
/// 只认回环上的 LISTENING，末列是 pid（15 章：本服务只听 127.0.0.1，别把网关口的进程算了进来）。
#[cfg(windows)]
pub fn parse_netstat(text: &str, port: u16) -> Vec<u32> {
  let suffix = format!(":{port}");
  text
    .lines()
    .map(|line| line.to_uppercase())
    .filter(|line| line.contains("LISTENING"))
    .filter(|line| {
      line
        .split_whitespace()
        .nth(2)
        .is_some_and(|local| local.ends_with(&suffix) && local.starts_with("127."))
    })
    .filter_map(|line| line.split_whitespace().last()?.parse::<u32>().ok())
    .collect()
}

/// `lsof` 的端口选择参数：`-iTCP:7788` 必须是一个参数，拆开写会被当成文件位置参数。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn lsof_args(port: u16) -> [String; 4] {
  [
    "-n".to_string(),
    "-P".to_string(),
    format!("-iTCP:{port}"),
    "-t".to_string(),
  ]
}

/// 占用该端口的进程；认不出、不止一个、或就是我们自己时返回 `None`。
pub fn occupant(port: u16) -> Option<Occupant> {
  let pids = listener_pids(port)?;
  // 多个 pid 说明端口被父子进程共享，杀哪个都不是我们能替用户决定的。
  let [pid] = pids.as_slice() else {
    return None;
  };
  let pid = *pid;
  if pid == std::process::id() {
    return None;
  }
  Some(Occupant {
    pid,
    name: process_name(pid),
  })
}

fn listener_pids(port: u16) -> Option<Vec<u32>> {
  #[cfg(any(target_os = "macos", target_os = "linux"))]
  let output = Command::new("lsof").args(lsof_args(port)).output().ok()?;
  #[cfg(windows)]
  let output = Command::new("netstat")
    .args(["-ano", "-p", "tcp"])
    .output()
    .ok()?;
  #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
  {
    let _ = port;
    return None;
  }
  #[cfg(any(target_os = "macos", target_os = "linux", windows))]
  {
    // lsof 在「没有匹配」时以退出码 1 结束，这不是错误，就是没人占着。
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let pids = parse_pids(&text);
    #[cfg(windows)]
    let pids = parse_netstat(&text, port);
    Some(pids)
  }
}

fn process_name(pid: u32) -> String {
  #[cfg(any(target_os = "macos", target_os = "linux"))]
  let output = Command::new("ps")
    .args(["-o", "comm=", "-p", &pid.to_string()])
    .output();
  #[cfg(windows)]
  let output = Command::new("tasklist")
    .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
    .output();
  let name = output
    .ok()
    .filter(|out| out.status.success())
    .map(|out| {
      String::from_utf8_lossy(&out.stdout)
        .trim()
        .split(',')
        .next()
        .unwrap_or_default()
        .trim_matches('"')
        .to_string()
    })
    .unwrap_or_default();
  if name.is_empty() {
    "未知进程".to_string()
  } else {
    name
  }
}

/// 从 `from + 1` 开始的第一个空闲端口，最多向上试 [`PORT_SCAN_SPAN`] 格。
/// 挑中后 `Sidecar::start` 仍会真去 bind，抢输了就是普通启动失败，那条路会报出来。
pub fn next_free_port(from: u16) -> Option<u16> {
  (1..=PORT_SCAN_SPAN)
    .filter_map(|offset| from.checked_add(offset))
    .find(|candidate| !sidecar::port_in_use(*candidate))
}

/// 收掉 `port` 上的监听进程：先 SIGTERM 给它自己放开端口的机会，超时才 SIGKILL。
pub fn terminate(port: u16, target: &Occupant) -> Result<(), String> {
  signal(target.pid, false)?;
  if wait_until_released(port, Duration::from_secs(3)) {
    return Ok(());
  }
  signal(target.pid, true)?;
  if wait_until_released(port, Duration::from_secs(3)) {
    return Ok(());
  }
  Err(format!("已向 pid {} 发过信号，但端口 {port} 仍在被监听", target.pid))
}

#[cfg(unix)]
fn signal(pid: u32, force: bool) -> Result<(), String> {
  let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
  if unsafe { libc::kill(pid as i32, signal) } == 0 {
    return Ok(());
  }
  let error = std::io::Error::last_os_error();
  // EPERM/ESRCH 之外没什么可恢复的：报错，让用户自己决定要不要动手。
  Err(format!("向 pid {pid} 发信号失败：{error}"))
}

#[cfg(not(unix))]
fn signal(_pid: u32, _force: bool) -> Result<(), String> {
  Err("当前平台不支持终止占用进程，请改用「换个端口启动」".to_string())
}

fn wait_until_released(port: u16, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  loop {
    if !sidecar::port_in_use(port) {
      return true;
    }
    if Instant::now() >= deadline {
      return false;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
}

/// 端口冲突的选择题。必须在**非主线程**调用：`blocking_*` 要跳主线程等结果。
///
/// `can_switch` = 还能不能改端口。只有主窗口创建之前能改（生效端口被烧进
/// `window.rs` 的 `initialization_script`），托盘「重启服务」时窗口已经开着，
/// 换端口会让整个界面继续打旧端口，所以那条路径只提供「终止占用进程」。
/// 认不出占用者时连这一项也不给——不能提供一个我们无法安全兑现的选项。
pub fn ask(app: &AppHandle, port: u16, who: Option<&Occupant>, can_switch: bool) -> Choice {
  let mut body = if can_switch {
    format!(
      "端口 {port} 已被其他进程监听，本地服务起不来。\n\n\
       换端口会让四家 Agent 已配置的 MCP 地址全部失效（20.9），所以这一步要你显式确认。"
    )
  } else {
    format!(
      "端口 {port} 已被其他进程监听，服务重不起来。\n\n\
       主窗口已经按这个端口打开，改端口对界面不生效，只能腾出原端口。\
       想换端口的话请退出应用后重新启动。"
    )
  };
  if let Some(occupant) = who {
    body = format!("占用进程：{} (pid {})\n\n{body}", occupant.name, occupant.pid);
  }
  let buttons = match (can_switch, who) {
    (true, Some(_)) => {
      MessageDialogButtons::YesNoCancelCustom(SWITCH.to_string(), KILL.to_string(), SKIP.to_string())
    }
    (true, None) => MessageDialogButtons::OkCancelCustom(SWITCH.to_string(), SKIP.to_string()),
    (false, Some(_)) => MessageDialogButtons::OkCancelCustom(KILL.to_string(), SKIP.to_string()),
    // 既不能改端口又认不出占用者：没有任何可给的动作，说清楚就算了。
    (false, None) => MessageDialogButtons::Ok,
  };
  let result = app
    .dialog()
    .message(body)
    .title("端口被占用")
    .kind(MessageDialogKind::Warning)
    .buttons(buttons)
    .blocking_show_with_result();
  match result {
    MessageDialogResult::Custom(label) if label == SWITCH => Choice::Switch,
    MessageDialogResult::Custom(label) if label == KILL => Choice::Kill,
    // 关掉对话框、按「先不处理」、系统改写了按钮文案——一律当作放弃，不做破坏性动作。
    _ => Choice::Skip,
  }
}

/// 一条尝试没能把 sidecar 起来的两种收场。分开是因为 10.3 只要求「失败要弹原生框」，
/// 而用户自己选的「先不处理」不是失败，再弹一次就是骚扰。
enum Stop {
  /// 用户在端口冲突前选了放弃。
  Declined,
  /// 需要告诉用户的失败，正文已经排好版。
  Failed(String),
}

/// 拉起 sidecar 的完整流程，端口被占时按 10.3 问用户怎么办。
///
/// 必须从**非主线程**调用（`start` 与对话框都会阻塞）。无论成功、失败还是放弃，
/// 结束时都在**主线程**执行 `done`：启动路径用它建主窗口，托盘「重启服务」用它刷状态。
/// 两个入口的区别只在端口还可不可以改。
pub fn start_at_boot(app: &AppHandle, done: impl FnOnce(&AppHandle) + Send + 'static) {
  run(app, true, done);
}

/// 同 [`start_at_boot`]，但主窗口已经按当前端口打开了：换端口对界面不生效，
/// 所以冲突时只提供「终止占用进程」。
pub fn restart_in_place(app: &AppHandle, done: impl FnOnce(&AppHandle) + Send + 'static) {
  run(app, false, done);
}

fn run(app: &AppHandle, can_switch: bool, done: impl FnOnce(&AppHandle) + Send + 'static) {
  let shared = state::shared(app);
  let preferred = shared.sidecar.port();
  match attempt(app, &shared, preferred, can_switch) {
    Ok(port) => shared.log(&format!("sidecar 就绪，端口 {port}")),
    Err(Stop::Declined) => shared.log(&format!("端口 {preferred} 冲突，用户选择先不处理")),
    Err(Stop::Failed(message)) => {
      shared.log(&format!("sidecar 未启动：{message}"));
      // 10.3：不静默退出。窗口与托盘仍会由 `done` 建出来，托盘还留着「重启服务」。
      commands::error_dialog(
        app.clone(),
        "本地服务启动失败",
        format!("{message}\n\n窗口与托盘仍会打开，可用托盘「重启服务」再试一次。"),
      );
    }
  }
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || done(&handle));
}

/// 一次「尝试 → （若冲突）询问 → 补救 → 再尝试」，返回最终生效端口。
fn attempt(
  app: &AppHandle,
  shared: &state::Shared,
  preferred: u16,
  can_switch: bool,
) -> Result<u16, Stop> {
  let token = shared.token();
  let entry = shared.entry();
  if let Ok(info) = shared.sidecar.start(&entry, &token, preferred) {
    persist(shared, info.port);
    return Ok(info.port);
  }
  // 不是端口冲突（dist 缺失、ATB_READY 超时…）：没有可选项可给。
  let Some(port) = shared.sidecar.conflict() else {
    return Err(Stop::Failed(shared.sidecar.failure_report()));
  };

  let who = occupant(port);
  shared.log(&format!(
    "端口 {port} 被占用：{}",
    who.as_ref()
      .map(|item| format!("{} (pid {})", item.name, item.pid))
      .unwrap_or_else(|| "认不出占用进程".to_string())
  ));
  match ask(app, port, who.as_ref(), can_switch) {
    Choice::Switch => switch_port(app, shared, &entry, &token, port),
    Choice::Kill => kill_and_retry(shared, &entry, &token, port, who),
    Choice::Skip => Err(Stop::Declined),
  }
}

fn switch_port(
  app: &AppHandle,
  shared: &state::Shared,
  entry: &[String],
  token: &str,
  blocked: u16,
) -> Result<u16, Stop> {
  let candidate =
    next_free_port(blocked).ok_or_else(|| Stop::Failed(format!("{blocked} 往上 {PORT_SCAN_SPAN} 个端口都不空闲")))?;
  let info = shared
    .sidecar
    .start(entry, token, candidate)
    .map_err(|_| Stop::Failed(shared.sidecar.failure_report()))?;
  persist(shared, info.port);
  shared.log(&format!(
    "已改用端口 {}，Agent 侧的 MCP 地址要跟着改",
    info.port
  ));
  // 端口变了会造成「Agent 突然连不上」这种静默故障，必须当面说一次，不能只进日志。
  commands::notice_dialog(
    app.clone(),
    "已换个端口启动",
    format!(
      "本地服务现在监听 {}。\n托盘「复制 MCP 地址」给的就是新地址，四家 Agent 的配置要一起改。",
      info.port
    ),
  );
  Ok(info.port)
}

fn kill_and_retry(
  shared: &state::Shared,
  entry: &[String],
  token: &str,
  port: u16,
  who: Option<Occupant>,
) -> Result<u16, Stop> {
  let target = who.ok_or_else(|| Stop::Failed("认不出占用进程，没有可终止的对象".to_string()))?;
  terminate(port, &target).map_err(Stop::Failed)?;
  shared.log(&format!("已终止占用 {port} 的 pid {}", target.pid));
  let info = shared
    .sidecar
    .start(entry, token, port)
    .map_err(|_| Stop::Failed(shared.sidecar.failure_report()))?;
  persist(shared, info.port);
  Ok(info.port)
}

fn persist(shared: &state::Shared, port: u16) {
  if let Err(error) = paths::persist_port(port) {
    shared.log(&format!("{error}"));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// 占住一个临时端口，返回它和守卫（drop 即释放）。
  fn held() -> (u16, std::net::TcpListener) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind 临时端口");
    (listener.local_addr().unwrap().port(), listener)
  }

  #[test]
  fn occupied_port_is_not_picked_as_free() {
    let (port, _guard) = held();
    assert!(sidecar::port_in_use(port), "刚 bind 的端口应被判为占用");
    let next = next_free_port(port).expect("往上应能找到空闲端口");
    assert!(next > port);
    assert!(next <= port + PORT_SCAN_SPAN);
    assert!(!sidecar::port_in_use(next));
  }

  #[test]
  fn scan_stops_at_the_span_instead_of_wrapping() {
    // 不变式：只往上找，绝不回绕成小端口——MAX 自己已经没有上一格了。
    assert_eq!(next_free_port(u16::MAX), None);
    if let Some(port) = next_free_port(u16::MAX - 1) {
      assert!(port > u16::MAX - 1, "回绕了：{port}");
    }
  }

  #[cfg(any(target_os = "macos", target_os = "linux"))]
  #[test]
  fn lsof_selector_keeps_the_port_in_one_argument() {
    let args = lsof_args(7788);
    assert!(args.contains(&"-iTCP:7788".to_string()));
  }

  #[cfg(any(target_os = "macos", target_os = "linux"))]
  #[test]
  fn lsof_output_parser_skips_noise_lines() {
    assert_eq!(parse_pids("4321\n5678\n"), vec![4321, 5678]);
    assert_eq!(parse_pids("lsof: WARNING: something\n4321\n"), vec![4321]);
    assert!(parse_pids("").is_empty());
    assert!(parse_pids("lsof: no files match\n").is_empty());
  }

  #[test]
  fn a_port_we_listen_on_ourselves_has_no_occupant() {
    // 端口确实被占（本进程占的），但占它的就是我们自己：绝不能给出「终止占用进程」。
    let (port, _guard) = held();
    assert!(sidecar::port_in_use(port));
    assert_eq!(occupant(port).map(|item| item.pid), None);
  }

  #[cfg(windows)]
  #[test]
  fn netstat_parser_ignores_foreign_addresses_and_states() {
    let text = "  TCP    127.0.0.1:7788         0.0.0.0:0              LISTENING       4321\n\
                TCP    0.0.0.0:7788           0.0.0.0:0              LISTENING       9999\n\
                TCP    127.0.0.1:7788         127.0.0.1:52000        ESTABLISHED     1111\n";
    assert_eq!(parse_netstat(text, 7788), vec![4321]);
  }

  #[test]
  fn dialog_labels_are_distinct() {
    assert_ne!(SWITCH, KILL);
    assert_ne!(KILL, SKIP);
  }
}
