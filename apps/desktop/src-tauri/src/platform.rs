//! Windows 侧子进程能力的收口模块：凡是要拉起**控制台程序**（node.exe / cmd /
//! netstat / tasklist / taskkill）的地方都从这里过一遍。
//!
//! 为什么必须有：release 构建是 `windows_subsystem = "windows"` 的 GUI 进程
//! （`main.rs` 头部），它自己**没有**控制台；Windows 给控制台子系统的子进程
//! 分配新窗口发生在 CreateProcess 时，**与 stdio 有没有被重定向无关**——
//! 所以 `spawn()` 会闪黑框，`.output()` 管道捕获一样闪。唯一解是
//! `CREATE_NO_WINDOW`。逐个调用点手套 `#[cfg(windows)]` 迟早漏一处，
//! 收成 non-Windows 空操作后调用点无条件过一遍即可。
//!
//! 编译安全策略（开发机是 mac，`#[cfg(windows)]` 的函数体本机编译不到）：
//! argv 构造收在纯函数里、跨平台单测；Windows 专属函数体保持短到一眼看穿，
//! 且只走 `Command` + 系统自带 `taskkill.exe`，不引入新的 Windows 依赖。

use std::process::Command;

/// 给 `Command` 挂上「不弹控制台窗口」（`winuser.h` 的 `CREATE_NO_WINDOW`）。
/// 非 Windows 是空操作——正因签名跨平台，`sidecar::start` 这类调用点才不需要
/// 套 `cfg` 块，跨平台分支在 mac 的 `cargo check` 里也过类型检查。
pub(crate) fn hide_console(command: &mut Command) {
  #[cfg(windows)]
  {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  #[cfg(not(windows))]
  let _ = command;
}

/// `taskkill` 的 argv。纯函数、pid 与 `/T` 两个自由度都在 mac 上锁死：
/// `/T` 是「连子进程树一起收」与「只收这一个 pid」的分界，取舍看各自调用点注释。
/// mac 的 check 构建里唯一调用方（`run_taskkill`）被 cfg 掉了，只有测试在用——
/// 属性只免掉那条 dead_code 告警，不改变可见性。
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
fn taskkill_args(pid: u32, tree: bool) -> Vec<String> {
  let mut args = vec!["/PID".to_string(), pid.to_string()];
  if tree {
    args.push("/T".to_string());
  }
  args.push("/F".to_string());
  args
}

/// 执行一次 `taskkill`：成功与否只看退出码（它的文案随系统语言变，不可依赖），
/// 自己也是控制台程序，必须过 `hide_console`。
#[cfg(windows)]
pub(crate) fn run_taskkill(pid: u32, tree: bool) -> bool {
  let mut command = Command::new("taskkill");
  command
    .args(taskkill_args(pid, tree))
    .stdin(std::process::Stdio::null());
  hide_console(&mut command);
  command
    .output()
    .map(|output| output.status.success())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn taskkill_argv_switches_only_the_tree_flag() {
    // 收 sidecar 带 /T：直属 node.exe 下面还有 Prisma/agent 子进程，不带就成孤儿。
    assert_eq!(taskkill_args(4321, true).join(" "), "/PID 4321 /T /F");
    // 收端口占用者不带 /T：与 unix 只 kill 一个 pid 的口径对齐（10.3）。
    assert_eq!(taskkill_args(4321, false).join(" "), "/PID 4321 /F");
  }

  #[test]
  fn hide_console_is_callable_on_every_platform() {
    // mac 上空操作，但每个调用点都真实执行到这里——签名不允许只在 Windows 存在，
    // 否则调用点就得整段 cfg 掉，Windows 分支反而逃过本机类型检查。
    hide_console(&mut Command::new("taskkill"));
  }
}
