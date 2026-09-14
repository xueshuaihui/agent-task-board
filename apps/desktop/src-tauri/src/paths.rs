use std::fs;
use std::path::{Path, PathBuf};

/// 与 `apps/api/src/common/paths.ts` 同源的一份解析（那边注释也指向这里）。
///
/// 为什么主进程要自己再算一遍：`open_log_dir`、「重启服务」都要落到与 sidecar 完全相同的
/// 目录上，而 sidecar 的目录优先级是「ATB_DATA_DIR → 平台默认」。改一边必须改另一边。
pub const DEFAULT_PORT: u16 = 7788;

fn env_path(key: &str) -> Option<PathBuf> {
  std::env::var_os(key)
    .map(PathBuf::from)
    .filter(|value| !value.as_os_str().is_empty())
}

fn env_text(key: &str) -> Option<String> {
  std::env::var(key)
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

/// 对应 node 的 `path.resolve(fromEnv)`：相对值按当前工作目录展开。
fn absolutize(path: PathBuf) -> PathBuf {
  if path.is_absolute() {
    path
  } else {
    std::env::current_dir().map_or(path.clone(), |cwd| cwd.join(path))
  }
}

pub fn home_dir() -> PathBuf {
  let key = if cfg!(target_os = "windows") {
    "USERPROFILE"
  } else {
    "HOME"
  };
  env_path(key).unwrap_or_else(|| PathBuf::from("."))
}

/// Windows 的 `APPDATA`，其他平台就是家目录（paths.ts 里 win32 分支的同一套值）。
fn roaming_root() -> PathBuf {
  if cfg!(target_os = "windows") {
    env_path("APPDATA").unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
  } else {
    home_dir()
  }
}

/// 数据目录：默认 `~/.agent-board`，`ATB_DATA_DIR` 覆盖（20.6）。
pub fn data_dir() -> PathBuf {
  if let Some(from_env) = env_path("ATB_DATA_DIR") {
    return absolutize(from_env);
  }
  if cfg!(target_os = "windows") {
    roaming_root().join("agent-board")
  } else {
    home_dir().join(".agent-board")
  }
}

/// 日志目录独立于数据目录：备份不含它（paths.ts 的 logsDir() 逐平台对齐）。
pub fn logs_dir() -> PathBuf {
  if cfg!(target_os = "windows") {
    roaming_root().join("AgentTaskBoard").join("logs")
  } else if cfg!(target_os = "macos") {
    home_dir().join("Library").join("Logs").join("AgentTaskBoard")
  } else {
    env_path("XDG_STATE_HOME")
      .unwrap_or_else(|| home_dir().join(".local").join("state"))
      .join("AgentTaskBoard")
      .join("logs")
  }
}

/// 产物目录：`<数据目录>/artifacts`，与 `paths.ts` 的 `artifactsDir()` 同值。
/// 刻意收 `data_dir` 参数而不是再读一次环境——sidecar 拿到的就是我们注入的
/// `ATB_DATA_DIR`，两边必须由同一个输入派生，否则「关于」页显示的路径会和实际写入的错位。
pub fn artifacts_dir(data_dir: &Path) -> PathBuf {
  data_dir.join("artifacts")
}

/// 备份目录：`<数据目录>/backups`，对应 `paths.ts` 的 `backupsDir()`（20.6）。
pub fn backups_dir(data_dir: &Path) -> PathBuf {
  data_dir.join("backups")
}

/// 端口与运行期配置（10.3：「端口写入 `~/.agent-board/config.json`」）。
pub fn config_file() -> PathBuf {
  data_dir().join("config.json")
}

/// 窗口尺寸/位置记忆（20.9 的口径：不在日志目录，也不进 `settings` 表）。
pub fn window_state_file() -> PathBuf {
  data_dir().join("window-state.json")
}

pub fn ensure_dir(path: &Path) -> Result<(), String> {
  fs::create_dir_all(path).map_err(|error| format!("创建 {} 失败：{error}", path.display()))
}

fn read_config() -> Option<serde_json::Value> {
  let raw = fs::read_to_string(config_file()).ok()?;
  let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
  if parsed.is_object() {
    Some(parsed)
  } else {
    None
  }
}

/// 端口解析的**唯一口径**，与 `apps/api/src/common/paths.ts` 逐条对齐（两边各有一条断言同一个例）：
///
/// 1. `ATB_PORT`：去空白后必须是**纯 ASCII 十进制数字**，且落在 1..=65535；
///    `1e4`、`0x1F90`、`+8080`、`8080.0` 一律算非法（Node 原先用 `Number()` 解析会收下前三个，
///    于是同一个环境变量两边算出两个端口——MCP 地址与 sidecar 实际监听端口就此错位）。
/// 2. `config.json` 的 `port`：JSON 数字里数值为整且落在 1..=65535 才算合法。
///    JSON 不区分 `8080` 与 `8080.0`，Node 的 `Number.isInteger` 认它，这里也必须认。
/// 3. 都不合法就 `DEFAULT_PORT`；任何一级读失败都只降级，绝不让启动失败。
fn port_from_text(raw: &str) -> Option<u16> {
  let text = raw.trim();
  if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  text.parse::<u16>().ok().filter(|value| *value > 0)
}

fn port_from_number(value: &serde_json::Value) -> Option<u16> {
  let number = value.as_f64()?;
  if number.fract() != 0.0 {
    return None;
  }
  i64::try_from(number)
    .ok()
    .and_then(|whole| u16::try_from(whole).ok())
    .filter(|value| *value > 0)
}

fn config_port() -> Option<u16> {
  port_from_number(read_config()?.get("port")?)
}

/// 端口三级决定：`ATB_PORT` → `config.json` 的 `port` → 7788（20.9 明确它不进 `settings`）。
pub fn resolve_port() -> u16 {
  if let Some(raw) = env_text("ATB_PORT") {
    if let Some(value) = port_from_text(&raw) {
      return value;
    }
    eprintln!("[desktop] ATB_PORT={raw} 不是合法端口，按下一级解析");
  }
  config_port().unwrap_or(DEFAULT_PORT)
}

/// 把生效端口写回 `config.json`：验收 15「重启服务后端口不变」，也让下次不带 `ATB_PORT`
/// 的启动落在同一个端口上。未知键原样保留。
pub fn persist_port(port: u16) -> Result<(), String> {
  let file = config_file();
  ensure_dir(
    file
      .parent()
      .ok_or_else(|| format!("{} 没有父目录", file.display()))?,
  )?;
  let mut config = match read_config() {
    Some(value) => value,
    None => serde_json::json!({}),
  };
  config["port"] = serde_json::Value::from(u64::from(port));
  let body =
    serde_json::to_string_pretty(&config).map_err(|error| format!("序列化 config.json 失败：{error}"))?;
  fs::write(&file, format!("{body}\n")).map_err(|error| format!("写 {} 失败：{error}", file.display()))?;
  restrict_to_owner(&file);
  Ok(())
}

/// 与 `apps/api` 写 dev-ui-token 时的 0600 一致：数据目录里的运行期文件不给同机其他用户读。
pub fn restrict_to_owner(path: &Path) {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
  }
  #[cfg(not(unix))]
  {
    let _ = path;
  }
}
