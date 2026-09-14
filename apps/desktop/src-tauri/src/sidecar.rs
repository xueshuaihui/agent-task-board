use std::io::{BufRead, BufReader};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::AppHandle;

use crate::paths;
use crate::state;
use crate::tray;

/// 9.4.1 第 4 步：`apps/api/src/main.ts` 的 `ready()` 往 stdout 打的一行
/// `ATB_READY {"port":n,"pid":n,"version":"s"}`。读不到就是启动失败，没有第二条路径。
pub const READY_PREFIX: &str = "ATB_READY ";

/// 失败对话框要能贴出最近的输出，留 40 行足够定位。
const TAIL_CAPACITY: usize = 40;

/// 把子进程输出转成主进程诊断日志（desktop.log）的回调。
pub type OutputSink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
pub struct ReadyInfo {
  pub port: u16,
  pub pid: u32,
  #[serde(default)]
  pub version: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn push_line(tail: &Mutex<Vec<String>>, line: &str) {
  let mut guard = lock(tail);
  if guard.len() >= TAIL_CAPACITY {
    guard.remove(0);
  }
  guard.push(line.to_string());
}

/// `ATB_SIDECAR_CMD` 是按空白切分的命令行（支持单/双引号包住带空格的路径）。
fn split_command(raw: &str) -> Vec<String> {
  let mut parts = Vec::new();
  let mut current = String::new();
  let mut quote: Option<char> = None;
  let mut started = false;
  for ch in raw.chars() {
    if let Some(opened) = quote {
      if ch == opened {
        quote = None;
      } else {
        current.push(ch);
      }
      continue;
    }
    match ch {
      '\'' | '"' => {
        quote = Some(ch);
        started = true;
      }
      ' ' | '\t' => {
        if started {
          parts.push(std::mem::take(&mut current));
          started = false;
        }
      }
      _ => {
        current.push(ch);
        started = true;
      }
    }
  }
  if started {
    parts.push(current);
  }
  parts
}

/// 解析运行 sidecar 用的 node 可执行文件，优先级从高到低：
/// 1. `ATB_NODE_BIN` —— 显式指定（最高优先，便于调试/替换）；
/// 2. `<resource_dir>/sidecar/node` —— 随 `.app` 打包进 Resources 的 node，保证从 Finder 双击启动也能用；
/// 3. 系统 `node` —— 仅开发/未打包时依赖 PATH。
fn resolve_node(resource_dir: Option<&Path>) -> String {
  if let Some(raw) = std::env::var("ATB_NODE_BIN")
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
  {
    return raw;
  }
  if let Some(dir) = resource_dir {
    let bundled = dir.join("sidecar").join("node");
    if bundled.is_file() {
      return bundled.display().to_string();
    }
  }
  "node".to_string()
}

/// 三档解析（优先级从高到低）：
/// 1. `ATB_SIDECAR_CMD` —— 不打包就能验，可以把入口指到任意路径；
/// 2. `<resource_dir>/sidecar/main.js` —— 阶段二把 sidecar 随 `.app` 打包后的布局；
/// 3. 编译期注入的 `apps/api/dist/main.js`（`npm run build -w @atb/api` 的产物）+ `node`。
pub fn resolve_entry(resource_dir: Option<&Path>) -> Vec<String> {
  if let Some(raw) = std::env::var("ATB_SIDECAR_CMD")
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
  {
    let parts = split_command(&raw);
    if !parts.is_empty() {
      return parts;
    }
  }
  if let Some(dir) = resource_dir {
    let bundled = dir.join("sidecar").join("main.js");
    if bundled.is_file() {
      return vec![resolve_node(Some(dir)), bundled.display().to_string()];
    }
  }
  vec![resolve_node(None), env!("ATB_DEV_SIDECAR_ENTRY").to_string()]
}

/// UI 会话 Token：随机 32 字节 hex（64 字符，满足 sidecar 的 `length >= 32`），
/// 只存主进程内存：既不落盘，也不进日志（9.4.1 第 2 步）。
fn random_token() -> Result<String, String> {
  let mut buf = [0u8; 32];
  getrandom::fill(&mut buf).map_err(|error| format!("生成 UI 会话 Token 失败：{error}"))?;
  Ok(buf.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 仅 debug 构建允许用 `ATB_UI_TOKEN` 钉住 Token 以便脚本化联调；release 永远随机生成。
pub fn resolve_token() -> Result<String, String> {
  #[cfg(debug_assertions)]
  if let Some(raw) = std::env::var("ATB_UI_TOKEN")
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| value.len() >= 32)
  {
    eprintln!("[desktop] 使用 ATB_UI_TOKEN 注入值（仅 debug 构建；release 忽略该变量）");
    return Ok(raw);
  }
  random_token()
}

fn ready_timeout() -> Duration {
  let secs = std::env::var("ATB_SIDECAR_TIMEOUT_SECS")
    .ok()
    .and_then(|raw| raw.trim().parse::<u64>().ok())
    .filter(|value| *value > 0)
    .unwrap_or(60);
  Duration::from_secs(secs)
}

/// 端口是否已被监听：先探一次，比等 sidecar 抛 EADDRINUSE 再猜原因清楚得多（10.3）。
pub(crate) fn port_in_use(port: u16) -> bool {
  let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
  TcpStream::connect_timeout(&address.into(), Duration::from_millis(250)).is_ok()
}

#[cfg(unix)]
fn signal_group(pid: u32, force: bool) -> bool {
  let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
  // 负号 = 整个进程组：sidecar 自己再 fork 的子进程一起收（start 里 process_group(0) 建的组）。
  let grouped = unsafe { libc::kill(-(pid as i32), signal) };
  if grouped == 0 {
    return true;
  }
  // 回落单个进程：进程组不存在时（比如没走 start 的 process_group 路径）至少收掉直属子进程。
  let single = unsafe { libc::kill(pid as i32, signal) };
  single == 0
}

#[cfg(not(unix))]
fn signal_group(pid: u32, force: bool) -> bool {
  let _ = (pid, force);
  false
}

pub struct Sidecar {
  port: AtomicU16,
  /// 最近一次 `start` 因端口被占而失败的那个端口，0 = 不是端口冲突。
  /// 调用方靠它区分「该走 10.3 的两选项流程」还是「普通启动失败」。
  conflict: AtomicU16,
  pid: AtomicU32,
  running: AtomicBool,
  version: Mutex<String>,
  error: Mutex<Option<String>>,
  tail: Arc<Mutex<Vec<String>>>,
  child: Mutex<Option<Child>>,
  sink: OutputSink,
}

impl Sidecar {
  pub fn new(preferred_port: u16, sink: OutputSink) -> Self {
    Self {
      port: AtomicU16::new(preferred_port),
      conflict: AtomicU16::new(0),
      pid: AtomicU32::new(0),
      running: AtomicBool::new(false),
      version: Mutex::new(String::new()),
      error: Mutex::new(None),
      tail: Arc::new(Mutex::new(Vec::new())),
      child: Mutex::new(None),
      sink,
    }
  }

  pub fn port(&self) -> u16 {
    self.port.load(Ordering::Relaxed)
  }

  /// 最近一次启动失败是否由端口被占引起（10.3 两选项流程的入口条件）。
  pub fn conflict(&self) -> Option<u16> {
    match self.conflict.load(Ordering::Relaxed) {
      0 => None,
      port => Some(port),
    }
  }

  pub fn pid(&self) -> u32 {
    self.pid.load(Ordering::Relaxed)
  }

  pub fn is_running(&self) -> bool {
    self.running.load(Ordering::Relaxed)
  }

  /// 仅单测：别的模块要摆一个「进程活着 / 已经挂了」的事实来验自己的推导，
  /// 但又不该为此真起一个进程。生产路径上只有 `start` / `fail` / `poll_exit` / `stop` 动这个位。
  #[cfg(test)]
  pub(crate) fn set_running_for_test(&self, value: bool) {
    self.running.store(value, Ordering::SeqCst);
  }

  pub fn version(&self) -> String {
    lock(&self.version).clone()
  }

  pub fn error(&self) -> Option<String> {
    lock(&self.error).clone()
  }

  /// 托盘「复制 MCP 地址」的取值（10.4）：端口取生效值，不是硬编码 7788。
  pub fn mcp_address(&self) -> String {
    format!("http://127.0.0.1:{}/mcp", self.port())
  }

  /// 给原生对话框用的一屏诊断：失败原因 + 最近的 stderr/stdout 尾巴。
  pub fn failure_report(&self) -> String {
    let tail = lock(&self.tail);
    let mut text = self.error().unwrap_or_else(|| "sidecar 未就绪".to_string());
    if !tail.is_empty() {
      text.push_str("\n\n最近输出：\n");
      text.push_str(&tail.join("\n"));
    }
    text
  }

  /// 拉起 sidecar 并阻塞到 `ATB_READY`（9.4.1 第 3、4 步）。
  pub fn start(&self, entry: &[String], token: &str, port: u16) -> Result<ReadyInfo, String> {
    if self.is_running() {
      return Err("sidecar 已在运行；请先停止再启动".to_string());
    }
    {
      let mut guard = lock(&self.tail);
      guard.clear();
    }
    let (program, args) = entry.split_first().ok_or_else(|| {
      "未解析到 sidecar 启动命令（检查 ATB_SIDECAR_CMD 或 apps/api/dist/main.js 是否存在）".to_string()
    })?;
    self.port.store(port, Ordering::Relaxed);
    self.conflict.store(0, Ordering::Relaxed);
    if port_in_use(port) {
      self.conflict.store(port, Ordering::Relaxed);
      let message = format!("端口 {port} 已被其他进程监听，sidecar 起不来。");
      *lock(&self.error) = Some(message.clone());
      (self.sink)(&format!("sidecar 启动失败：{message}"));
      return Err(message);
    }

    let mut command = Command::new(program);
    command
      .args(args)
      .env("ATB_PORT", port.to_string())
      .env("ATB_UI_TOKEN", token)
      // 数据目录与主进程同源：sidecar 的库/产物/备份/日志都从它派生。
      .env("ATB_DATA_DIR", paths::data_dir())
      // 启动失败时 Nest 直接 process.exit(1)，错误默认只进日志文件；这里要拿到 stderr 才能弹框。
      .env("ATB_CONSOLE", "1")
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    // debug 构建里可能同时跑 vite:5173，sidecar 需要放行那条精确 Origin（origins.ts 的 DEV_ORIGINS）。
    #[cfg(debug_assertions)]
    command.env("ATB_DEV", "1");
    #[cfg(unix)]
    {
      use std::os::unix::process::CommandExt;
      // 独立进程组：退出时能整组收掉，不给本机留孤儿 sidecar。
      command.process_group(0);
    }

    let mut child = command.spawn().map_err(|error| {
      let message = format!(
        "拉起 sidecar 失败：`{program}` → {error}\n\
         先跑 `npm run build -w @atb/api` 产出 dist；也可用 ATB_SIDECAR_CMD 指定完整命令，\
         或用 ATB_NODE_BIN 指定 node 可执行文件路径。"
      );
      *lock(&self.error) = Some(message.clone());
      (self.sink)(&format!("sidecar 启动失败：{message}"));
      message
    })?;
    let pid = child.id();
    let stdout = child
      .stdout
      .take()
      .ok_or_else(|| "拿不到 sidecar 的 stdout，无法确认 ATB_READY".to_string())?;
    let stderr = child.stderr.take().expect("刚 piped 过 stderr");

    *lock(&self.child) = Some(child);
    self.pid.store(pid, Ordering::Relaxed);
    self.running.store(true, Ordering::SeqCst);
    *lock(&self.error) = None;
    (self.sink)(&format!(
      "sidecar 已拉起 pid={pid}：{program} {}",
      args.join(" ")
    ));

    let (tx, rx) = mpsc::channel::<ReadyInfo>();
    let stdout_tail = Arc::clone(&self.tail);
    let stdout_sink = Arc::clone(&self.sink);
    thread::spawn(move || {
      let mut sender = Some(tx);
      let reader = BufReader::new(stdout);
      for line in reader.lines() {
        let Ok(line) = line else { break };
        if let Some(payload) = line.trim().strip_prefix(READY_PREFIX) {
          if let Ok(info) = serde_json::from_str::<ReadyInfo>(payload) {
            if let Some(sender) = sender.take() {
              let _ = sender.send(info);
            }
            continue;
          }
        }
        push_line(&stdout_tail, &format!("stdout: {line}"));
        (stdout_sink)(&format!("sidecar stdout: {line}"));
      }
    });
    let stderr_tail = Arc::clone(&self.tail);
    let stderr_sink = Arc::clone(&self.sink);
    thread::spawn(move || {
      let reader = BufReader::new(stderr);
      for line in reader.lines() {
        let Ok(line) = line else { break };
        push_line(&stderr_tail, &format!("stderr: {line}"));
        (stderr_sink)(&format!("sidecar stderr: {line}"));
      }
    });

    let deadline = Instant::now() + ready_timeout();
    loop {
      match rx.recv_timeout(Duration::from_millis(200)) {
        Ok(info) => {
          self.port.store(info.port, Ordering::Relaxed);
          self.pid.store(info.pid, Ordering::Relaxed);
          *lock(&self.version) = info.version.clone();
          (self.sink)(&format!(
            "sidecar 就绪：port={} pid={} version={}",
            info.port, info.pid, info.version
          ));
          return Ok(info);
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
          return self.fail("sidecar 的 stdout 已关闭，但没打出 ATB_READY 行");
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
          if self.poll_exit().is_some() {
            return self.fail("sidecar 在就绪前退出");
          }
          if Instant::now() >= deadline {
            self.stop();
            return self.fail(&format!(
              "{}s 内没有等到 ATB_READY 行",
              ready_timeout().as_secs()
            ));
          }
        }
      }
    }
  }

  fn fail(&self, reason: &str) -> Result<ReadyInfo, String> {
    self.running.store(false, Ordering::SeqCst);
    let message = {
      let tail = lock(&self.tail);
      if tail.is_empty() {
        reason.to_string()
      } else {
        format!("{reason}\n最近输出：\n{}", tail.join("\n"))
      }
    };
    *lock(&self.error) = Some(message.clone());
    (self.sink)(&format!("sidecar 启动失败：{message}"));
    Err(message)
  }

  /// 收割已退出的子进程；还在跑（或已被 `stop()` 收走）返回 None。
  pub fn poll_exit(&self) -> Option<std::process::ExitStatus> {
    let mut guard = lock(&self.child);
    let Some(child) = guard.as_mut() else {
      return None;
    };
    match child.try_wait() {
      Ok(Some(status)) => {
        let pid = self.pid.load(Ordering::Relaxed);
        *guard = None;
        drop(guard);
        self.running.store(false, Ordering::SeqCst);
        (self.sink)(&format!("sidecar 进程结束 pid={pid}：{status}"));
        Some(status)
      }
      _ => None,
    }
  }

  /// 结束 sidecar：先对整个进程组发 SIGTERM（Nest 的 shutdown hooks 要收尾），
  /// 3s 不退再 SIGKILL。只有托盘「退出」「重启服务」与超时兜底会走到这里（9.4.1）。
  pub fn stop(&self) -> Option<u32> {
    let mut guard = lock(&self.child);
    let Some(mut child) = guard.take() else {
      drop(guard);
      self.running.store(false, Ordering::SeqCst);
      return None;
    };
    let pid = child.id();
    let signaled = signal_group(pid, false);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
      match child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) => {
          if Instant::now() >= deadline {
            if !signal_group(pid, true) && !signaled {
              let _ = child.kill();
            }
            let _ = child.wait();
            break;
          }
          thread::sleep(Duration::from_millis(50));
        }
        Err(_) => {
          let _ = child.kill();
          let _ = child.wait();
          break;
        }
      }
    }
    self.running.store(false, Ordering::SeqCst);
    drop(guard);
    (self.sink)(&format!("sidecar 已停止 pid={pid}"));
    Some(pid)
  }
}

/// 监管线程：sidecar 自己挂了（不是我们杀的）→ 托盘转错误态 + 通知前端（7.4、10.4）。
pub fn spawn_monitor(app: AppHandle) {
  thread::spawn(move || loop {
    thread::sleep(Duration::from_millis(2_000));
    let shared = state::shared(&app);
    let Some(status) = shared.sidecar.poll_exit() else {
      if state::quitting(&app) {
        break;
      }
      continue;
    };
    if state::quitting(&app) {
      break;
    }
    shared.log(&format!(
      "sidecar 异常退出（{}），托盘转错误态；用托盘「重启服务」恢复",
      status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "信号终止".to_string())
    ));
    tray::refresh(&app);
    state::publish_status(&app, "stopped");
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ready_line_parses() {
    let line = r#"ATB_READY {"port":7788,"pid":4242,"version":"0.1.0"}"#;
    let payload = line.strip_prefix(READY_PREFIX).expect("前缀");
    let info: ReadyInfo = serde_json::from_str(payload).expect("就绪行");
    assert_eq!((info.port, info.pid), (7788, 4242));
    assert_eq!(info.version, "0.1.0");
  }

  #[test]
  fn other_stdout_lines_are_not_ready() {
    assert!(serde_json::from_str::<ReadyInfo>("{\"port\":1}").is_err());
    assert!("node: bad options".strip_prefix(READY_PREFIX).is_none());
  }

  #[test]
  fn command_splitting_keeps_quoted_paths() {
    assert_eq!(
      split_command("node \"/tmp/a b/main.js\" --x"),
      vec!["node", "/tmp/a b/main.js", "--x"]
    );
    assert_eq!(split_command("  node   main.js "), vec!["node", "main.js"]);
  }

  #[test]
  fn mcp_address_follows_effective_port() {
    let sink: OutputSink = Arc::new(|_| {});
    let sidecar = Sidecar::new(7788, sink);
    assert_eq!(sidecar.mcp_address(), "http://127.0.0.1:7788/mcp");
    sidecar.port.store(7899, Ordering::Relaxed);
    assert_eq!(sidecar.mcp_address(), "http://127.0.0.1:7899/mcp");
  }
}
