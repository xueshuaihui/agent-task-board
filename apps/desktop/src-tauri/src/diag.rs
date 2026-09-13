use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 主进程自己的诊断日志：`<logsDir>/desktop.log`。
///
/// 为什么不进 sidecar 的 winston：sidecar 可能根本没起来（正是最需要日志的那次），
/// 而托盘/窗口的问题也只在这一侧。日志目录与 sidecar 同源（paths::logs_dir），
/// 所以托盘「查看日志」打开的就是这个目录。
pub fn stamp() -> String {
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or_default();
  //  civil-from-days（Howard Hinnant）：不为此引 chrono。
  let days = secs.div_euclid(86_400);
  let rem = secs.rem_euclid(86_400);
  let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
  let z = days + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = if m <= 2 { y + 1 } else { y };
  format!("{y:04}-{m:02}-{d:02} {hour:02}:{minute:02}:{second:02}")
}

/// 追加一行；目录不存在或写失败都只吐到 stderr，日志本身不该把应用带崩。
pub fn append_line(dir: &Path, file_name: &str, level: &str, message: &str) {
  use std::fs::OpenOptions;
  use std::io::Write;

  let line = format!("{} [{level}] {message}\n", stamp());
  eprint!("{line}");
  let _ = std::fs::create_dir_all(dir);
  let path = dir.join(file_name);
  if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(&path) {
    let _ = handle.write_all(line.as_bytes());
  }
}
