//! 10.4 托盘角标：未读数由**主进程**每 [`POLL_INTERVAL`] 向 sidecar 轮询一次。
//!
//! 为什么是主进程轮询、而不是 WebView 或 WS：
//! - 本应用点关闭按钮只是把窗口隐藏（`main.rs` 的 `CloseRequested` → `window::hide`），
//!   窗口一长期隐藏，WebView 的定时器就被平台节流（后台/不可见页面的 `setInterval`
//!   会被压到分钟级甚至停摆），角标会停在最后一次的值上不动；
//! - WS 那条路 `notification.created` 只在**有连接**时推得出来，同一时刻窗口可能就是关着的
//!   （10.4 原话：「不经 WS，避免窗口关闭时无人持有连接」）。
//! 主进程里的普通线程两头都不受影响，所以 10.4 把这件事派给了它。
//!
//! 依赖形状：Cargo.toml 刻意最小，不为这一个 GET 引 HTTP 客户端。这里只用
//! `std::net::TcpStream` 手写一次「发一行请求 → 读到 EOF → 切出响应体」的往返，
//! 并且**只**认 sidecar 实际会给的那一种响应（2xx + `Content-Length` + 一个 JSON 对象）；
//! 其余形态一律判失败，让托盘切到「服务已停止」而不是猜。
//!
//! Token 的去向：只在这条线程的内存里过一遍，拼进 `build_request` 的返回值即用即弃——
//! 不落盘、不进日志、不进任何错误消息（9.4.1 第 2 步）。失败日志只有 io/解析原因。

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::state;
use crate::tray;

/// 轮询间隔：PRD 10.4 写死的 30 秒（「由主进程每 30 秒向 sidecar 轮询一次」）。
/// 不经 WS 是因为窗口关闭时 WebView 定时器会被节流——见模块头的说明，
/// 隐藏窗口的这段时间里只有这条线程还在跑，角标才不会停滞。
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// 睡 [`POLL_INTERVAL`] 期间每这么久醒一次，只为两件事：发现应用要退出、发现
/// sidecar 刚从「停」变「起」（那条路径要立刻补一轮，见 [`wait_until_due`]）。
const TICK_SLICE: Duration = Duration::from_millis(500);

/// 连接与读写超时。2s 对「本机回环上一个已经 ready 的 Nest 进程」足够宽裕，
/// 又远小于轮询间隔：sidecar 卡死时这条线程最多一次占住 2s，不会越积越多。
const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// 单次响应的字节上限：**必须高于正常数据的峰值**，否则一个满 100 条未读的用户会被
/// 常驻误判成「服务已停止」。峰值这么算：`GET /notifications?unread=true` 单次最多 100 条，
/// 单条 `message` 最坏是「任务 ID + 审核原因（≤5000 字）+ 任务标题（≤200 字）」，
/// 中文按 UTF-8 3 字节计 ≈ 15.7KB → 约 1.6MB，再留一倍余量。
/// 超了仍然判失败：对端要是一直吐，总得有个「不跟它玩」的边界，
/// 免得一个坏掉的 sidecar 把主进程喂成 OOM。正常一轮只读几百字节，这个数不预分配。
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// 只问未读数，形状按 10.4 与 13 章接口表逐字来。服务端 `notificationsQuerySchema`
/// 只声明 `unread`，所以这里不多带任何自造参数（比如 `limit`——它不被识别，也就不会让响应变小，
/// 摆着只会让人误以为「响应已经按 limit 收过」，体积全由上面那个字节上限兜着）。
const REQUEST_PATH: &str = "/api/v1/notifications?unread=true";

/// 唯一允许连的目标：sidecar 只听 127.0.0.1（`apps/api/src/main.ts` 的 `LISTEN_HOST`），
/// 我们也不给它换别名的机会（20.13：任何情况下不监听、也不连非回环）。
const HOST: &str = "127.0.0.1";

/// HTTP 头与响应体的分界。
const HEADER_END: &[u8] = b"\r\n\r\n";

/// 请求行 + 三行头 + 空行。Host 用当前生效端口（10.3 换过端口之后不能还对旧端口说话），
/// `Authorization` 是这条 Token 在全工程里唯一的一次出场。
fn build_request(port: u16, token: &str) -> String {
  format!(
    "GET {REQUEST_PATH} HTTP/1.1\r\n\
     Host: {HOST}:{port}\r\n\
     Authorization: Bearer {token}\r\n\
     Connection: close\r\n\r\n"
  )
}

/// 把「主机字面量 + 端口」收成只能回环的连接目标。
///
/// 只有 IPv4 回环字面量过得去：`localhost`（要解析，解析到什么我们说了不算）、`::1`、
/// `0.0.0.0`、公网地址、空串、端口 0 全部判错。这条线程手里握着 UI Token，
/// 宁可这一轮失败，也不能把 `Bearer` 发往任何一个非回环地址。
fn loopback_target(host: &str, port: u16) -> Result<SocketAddrV4, String> {
  let ip = host
    .trim()
    .parse::<Ipv4Addr>()
    .map_err(|_| format!("目标 {host:?} 不是 IPv4 字面量，拒绝连接"))?;
  if !ip.is_loopback() {
    return Err(format!("目标 {ip} 不是回环地址，拒绝连接"));
  }
  if port == 0 {
    return Err("端口还是 0：sidecar 没有定下生效端口".to_string());
  }
  Ok(SocketAddrV4::new(ip, port))
}

/// 读满到 EOF，全程守着 [`MAX_RESPONSE_BYTES`]。
///
/// 收泛型 `R: Read` 是为了能拿内存里的字节流单测这条路径（超限、读失败），
/// 不用真起一个服务器。
fn read_capped<R: Read>(reader: &mut R) -> Result<Vec<u8>, String> {
  let mut body = Vec::new();
  let mut chunk = [0u8; 4096];
  loop {
    match reader.read(&mut chunk) {
      Ok(0) => return Ok(body),
      Ok(read) => {
        body.extend_from_slice(&chunk[..read]);
        if body.len() > MAX_RESPONSE_BYTES {
          return Err("响应超过字节上限，已丢弃".to_string());
        }
      }
      // 信号打断（EINTR）不是故障，接着读；其余（含 2s 超时）都原样报出去。
      Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
      Err(error) => return Err(format!("读响应失败：{error}")),
    }
  }
}

/// 一次完整响应字节流 → `unread_count`。纯函数，单测就打这里。
///
/// 只接受「2xx + `Content-Length` + 一个带整数 `unread_count` 的 JSON 对象」，
/// 因为那就是 sidecar（Express + `res.json`）会给的唯一形态。其余形态——非 2xx、
/// `Transfer-Encoding`、缺 `Content-Length`、头或体被截断、超限、键缺失或不是非负整数——
/// 全部 `Err(原因)`；错误消息里只有状态码与解析原因，**不含响应体**（体里可能有任务标题）。
fn parse_unread_response(raw: &[u8]) -> Result<u32, String> {
  if raw.is_empty() {
    return Err("响应为空".to_string());
  }
  if raw.len() > MAX_RESPONSE_BYTES {
    return Err(format!("响应超过 {} 字节上限", raw.len()));
  }
  if raw.len() < HEADER_END.len() {
    return Err("响应头不完整（没读到 \\r\\n\\r\\n）".to_string());
  }
  let split = raw
    .windows(HEADER_END.len())
    .position(|window| window == HEADER_END)
    .ok_or_else(|| "响应头不完整（没读到 \\r\\n\\r\\n）".to_string())?;
  let head = String::from_utf8_lossy(&raw[..split]);
  let body = &raw[split + HEADER_END.len()..];

  let mut lines = head.split("\r\n");
  // 状态行 `HTTP/1.1 200 OK`：第 1 段是版本，第 2 段是状态码，短语不看。
  let status_line = lines.next().unwrap_or_default();
  let mut words = status_line.split_whitespace();
  let version = words.next().unwrap_or_default();
  if !version.starts_with("HTTP/1.") {
    return Err(format!("不是 HTTP/1.x 响应：{version:?}"));
  }
  let code: u16 = words
    .next()
    .ok_or_else(|| "状态行里没有状态码".to_string())?
    .parse()
    .map_err(|_| "状态码不是数字".to_string())?;
  if !(200..=299).contains(&code) {
    // 401/403/404/500 一律只报状态码：Token 在请求里，响应的错误体也不该进我们的日志。
    return Err(format!("HTTP 状态 {code}"));
  }

  let mut content_length: Option<u64> = None;
  for line in lines {
    let Some((name, value)) = line.split_once(':') else {
      continue;
    };
    match name.trim().to_ascii_lowercase().as_str() {
      // 分块传输要再走一层解码，而我们没有任何理由期待它（Express 对 JSON 给的是
      // Content-Length）。出现了就是预期外，判失败而不是硬解。
      "transfer-encoding" => return Err(format!("不支持分块响应：{value:?}")),
      "content-length" => {
        content_length = Some(
          value
            .trim()
            .parse()
            .map_err(|_| "Content-Length 不是数字".to_string())?,
        );
      }
      _ => {}
    }
  }
  // 没有它就判断不了「读全了没有」——除了 `Connection: close` 我们没有别的定界手段。
  let declared = content_length.ok_or_else(|| "响应缺 Content-Length，无法定界".to_string())?;
  let length = usize::try_from(declared).map_err(|_| "Content-Length 超出可表示范围".to_string())?;
  if length > MAX_RESPONSE_BYTES {
    return Err(format!("声明的响应体 {length} 字节超过上限"));
  }
  if body.len() < length {
    return Err(format!("响应体被截断：声明 {length} 字节，实得 {}", body.len()));
  }
  // 按声明长度切：`Connection: close` 之后不该有多余字节，但真有多余（比如对端又塞了一行
  // keep-alive 的响应头）也不该因此读不出我们那一个数字。
  let value: serde_json::Value =
    serde_json::from_slice(&body[..length]).map_err(|error| format!("响应体不是 JSON：{error}"))?;
  let count = value
    .get("unread_count")
    .ok_or_else(|| "响应里没有 unread_count".to_string())?
    .as_u64()
    .ok_or_else(|| "unread_count 不是非负整数".to_string())?;
  // 数字大到 u32 装不下时这不是「未读数」，是脏数据，当失败处理。
  u32::try_from(count).map_err(|_| format!("unread_count {count} 超出 u32"))
}

/// 一轮完整的 HTTP 往返：连 → 发 → 读到 EOF → 解析。
fn fetch_unread_count(port: u16, token: &str) -> Result<u32, String> {
  // 守卫在 connect 之前：不合法的 host/端口一个包都不会发出去。
  let address = loopback_target(HOST, port)?;
  let request = build_request(port, token);
  let mut stream = TcpStream::connect_timeout(&address.into(), IO_TIMEOUT)
    .map_err(|error| format!("连接 {HOST}:{port} 失败：{error}"))?;
  stream
    .set_read_timeout(Some(IO_TIMEOUT))
    .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
    .map_err(|error| format!("设读写超时失败：{error}"))?;
  stream
    .write_all(request.as_bytes())
    .and_then(|()| stream.flush())
    .map_err(|error| format!("发请求失败：{error}"))?;
  // 带 Token 的那份请求文本到此为止，后面只碰字节流。
  drop(request);
  let raw = read_capped(&mut stream)?;
  parse_unread_response(&raw)
}

/// [`wait_until_due`] 的两种结局。
enum Wake {
  /// 到点了，或服务刚起来：该轮一次。
  Poll,
  /// 应用要退出：线程收工。
  Quit,
}

/// 睡满一个 [`POLL_INTERVAL`]，期间每 [`TICK_SLICE`] 醒一次看两件事。
///
/// 「sidecar 刚从停变起」要立刻补一轮，不然托盘「重启服务」成功的瞬间，
/// 角标和最坏情况下的红色态还得等满 30 秒才纠正。
/// `running` 是调用方持有的上一次观测（不是第四份状态，纯本线程的边沿检测）。
fn wait_until_due(app: &AppHandle, running: &mut bool) -> Wake {
  let deadline = Instant::now() + POLL_INTERVAL;
  loop {
    let shared = state::shared(app);
    let up = shared.sidecar.is_running();
    let just_started = up && !*running;
    *running = up;
    if just_started || Instant::now() >= deadline {
      return Wake::Poll;
    }
    if state::quitting(app) {
      return Wake::Quit;
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    thread::sleep(remaining.min(TICK_SLICE));
  }
}

/// 一轮轮询 + 状态收敛。对外只做三件既有的事：`tray::set_badge`（数字）、
/// `tray::refresh`（图标与菜单首项）、`desktop.log`（日志），全都不自己另造实现。
fn poll_once(app: &AppHandle) {
  let shared = state::shared(app);
  if shared.quitting.load(Ordering::Relaxed) {
    return;
  }
  // 进程本来就没起：红色态归 `sidecar::spawn_monitor` 管（它 2 秒扫一次退出），
  // 这里再报一次「连不上」只是给日志添噪音，还会和它抢着设同一个态。
  // 顺手把自己那份「不可达」判词清掉——否则下一次「重启服务」成功的瞬间
  // 会被残留的判词染红，白等 30 秒。
  if !shared.sidecar.is_running() {
    shared.set_service_unreachable(false);
    return;
  }
  let port = shared.sidecar.port();
  match fetch_unread_count(port, &shared.token()) {
    Ok(count) => {
      if shared.set_service_unreachable(false) {
        shared.log(&format!("轮询恢复：端口 {port} 又可读了"));
        tray::refresh(app);
      }
      // 数字真变了才动角标：每 30 秒重设一次标题与 dock badge，只会让 macOS 无谓闪一下。
      if shared.unread.swap(count, Ordering::Relaxed) != count {
        tray::set_badge(app, count);
      }
    }
    Err(error) => {
      shared.log(&format!("轮询失败：{error}"));
      // `set_service_unreachable` 只在变化时返回 true，所以连续失败 100 轮也只刷一次红。
      if shared.set_service_unreachable(true) {
        tray::refresh(app);
      }
    }
  }
}

/// 起轮询线程（`main.rs` 的 setup 里调一次）。
pub fn spawn(app: AppHandle) {
  thread::spawn(move || {
    // 初值 false：启动时 sidecar 还在被 `conflict::start_at_boot` 拉起，
    // 它就绪的那一刻就是第一次轮询，不必等满 30 秒。
    let mut running = false;
    loop {
      match wait_until_due(&app, &mut running) {
        Wake::Quit => break,
        Wake::Poll => poll_once(&app),
      }
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;

  /// 拼一份完整响应（`Content-Length` 按实际长度算），给解析函数当输入。
  fn response(status: &str, extra_headers: &str, body: &str) -> Vec<u8> {
    format!(
      "HTTP/1.1 {status}\r\n\
       Content-Type: application/json; charset=utf-8\r\n\
       {extra_headers}\
       Content-Length: {}\r\n\
       Connection: close\r\n\r\n{body}",
      body.len()
    )
    .into_bytes()
  }

  #[test]
  fn a_whole_response_yields_unread_count() {
    let ok = |body: &str| parse_unread_response(&response("200 OK", "", body));
    assert_eq!(ok(r#"{"items":[],"unread_count":7}"#), Ok(7));
    // 0 是「没有未读」，不是「取不到」：必须原样收下，好让角标消失。
    assert_eq!(ok(r#"{"items":[],"unread_count":0}"#), Ok(0));
    // 真实形状：items 里带一整排通知，unread_count 在后面。
    assert_eq!(
      ok(r#"{"items":[{"id":"a","kind":"run_failed","message":"炸了"},{"id":"b","kind":"review_pending","message":"待审"}],"unread_count":2}"#),
      Ok(2)
    );
    // 边界与空白。
    assert_eq!(ok("{\n  \"items\" : [ ] ,\n  \"unread_count\" : 4294967295\n}\n"), Ok(u32::MAX));
  }

  #[test]
  fn unexpected_shapes_err_instead_of_panicking() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
      ("空输入", Vec::new()),
      ("只有一个字节", b"H".to_vec()),
      ("半个状态行", b"HTTP/1.1 2".to_vec()),
      ("只有头分隔符", b"\r\n\r\n".to_vec()),
      ("状态码不是数字", b"HTTP/1.1 abc OK\r\n\r\n{}".to_vec()),
      ("不是 HTTP/1.x", b"IRC/X 200 OK\r\n\r\n{}".to_vec()),
      ("状态行没有码", b"HTTP/1.1\r\n\r\n{}".to_vec()),
      ("没有头分隔符（截断）", b"HTTP/1.1 200 OK\r\nContent-Length: 21".to_vec()),
      (
        "体被截断",
        b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n{\"unread_count\":1}".to_vec(),
      ),
      (
        "缺 Content-Length",
        b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"unread_count\":1}".to_vec(),
      ),
      (
        "Content-Length 不是数字",
        b"HTTP/1.1 200 OK\r\nContent-Length: many\r\n\r\n{}".to_vec(),
      ),
      (
        "声明值大到装不下",
        b"HTTP/1.1 200 OK\r\nContent-Length: 99999999999999999999\r\n\r\n{}".to_vec(),
      ),
      (
        "声明值超上限",
        b"HTTP/1.1 200 OK\r\nContent-Length: 5000000\r\n\r\n{}".to_vec(),
      ),
      (
        "chunked 分块",
        response(
          "200 OK",
          "Transfer-Encoding: chunked\r\n",
          "3\r\n{\"u\r\n",
        ),
      ),
      ("401", response("401 Unauthorized", "", r#"{"error":"UNAUTHORIZED"}"#)),
      ("403", response("403 Forbidden", "", r#"{"error":"FORBIDDEN"}"#)),
      ("500", response("500 Internal Server Error", "", "{}")),
      ("204 无体", b"HTTP/1.1 204 No Content\r\n\r\n".to_vec()),
      ("体不是 JSON", response("200 OK", "", "<html>proxy said hi</html>")),
      ("体是 JSON 数组", response("200 OK", "", r#"[{"unread_count":1}]"#)),
      ("没有 unread_count", response("200 OK", "", r#"{"items":[]}"#)),
      ("unread_count 是字符串", response("200 OK", "", r#"{"unread_count":"3"}"#)),
      ("unread_count 是 null", response("200 OK", "", r#"{"unread_count":null}"#)),
      ("unread_count 是负数", response("200 OK", "", r#"{"unread_count":-1}"#)),
      ("unread_count 是小数", response("200 OK", "", r#"{"unread_count":1.5}"#)),
      ("unread_count 超出 u32", response("200 OK", "", r#"{"unread_count":4294967296}"#)),
      ("非 UTF-8 头部", b"HTTP/1.1 \xFF\xFE\r\n\r\n{}".to_vec()),
    ];
    for (name, raw) in cases {
      let outcome = parse_unread_response(&raw);
      assert!(outcome.is_err(), "{name} 应判失败，却给了 {outcome:?}");
    }
  }

  #[test]
  fn oversized_input_is_refused_by_both_layers() {
    // 解析层：光看长度就拒，不遍历。
    let huge = vec![b'x'; MAX_RESPONSE_BYTES + 1];
    assert!(parse_unread_response(&huge).is_err());
    // 读层：对端一直吐，读到超上限就撒手，攒不出第二份 64KB。
    assert!(read_capped(&mut std::io::Cursor::new(huge.clone())).is_err());
    // 恰好在上限内的完整小响应照样能读能解析。
    let small = response("200 OK", "", r#"{"unread_count":1}"#);
    assert!(small.len() < MAX_RESPONSE_BYTES);
    let read = read_capped(&mut std::io::Cursor::new(small.clone())).expect("该读全");
    assert_eq!(read.len(), small.len());
    assert_eq!(parse_unread_response(&read), Ok(1));
  }

  #[test]
  fn trailing_bytes_after_content_length_are_ignored() {
    let mut raw = response("200 OK", "", r#"{"unread_count":5}"#);
    raw.extend_from_slice(b"HTTP/1.1 200 OK\r\n\r\n{\"unread_count\":9}");
    assert_eq!(parse_unread_response(&raw), Ok(5));
  }

  #[test]
  fn read_errors_are_reported() {
    struct Broken;
    impl Read for Broken {
      fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "2s 超时"))
      }
    }
    let mut broken = Broken;
    let error = read_capped(&mut broken).expect_err("读失败应报出来");
    assert!(error.contains("读响应失败"), "{error}");
  }

  #[test]
  fn only_loopback_ipv4_with_a_real_port_is_connectable() {
    let target = loopback_target("127.0.0.1", 7899).expect("回环应放行");
    assert_eq!(target.ip(), &Ipv4Addr::LOCALHOST);
    assert_eq!(target.port(), 7899);
    // 127/8 整段都算回环（sidecar 只 bind .1，但目标仍在环内，不该被这条守卫拦下）。
    assert!(loopback_target("127.0.0.53", 7788).is_ok());
    // 其余一律拒：这些名字要是放行了，Token 就可能出现本机之外。
    for host in [
      "localhost",
      "::1",
      "0.0.0.0",
      "",
      "8.8.8.8",
      "10.0.0.1",
      "192.168.1.7",
      "example.com",
      "127.0.0.1:7788",
      "-1",
    ] {
      assert!(loopback_target(host, 7788).is_err(), "{host:?} 不该放行");
    }
    // 端口 0 = 还没定下生效端口（10.3 还没谈完），别对着它发东西。
    assert!(loopback_target("127.0.0.1", 0).is_err());
  }

  #[test]
  fn the_request_line_names_the_loopback_host_and_carries_the_token_once() {
    let request = build_request(7899, "t0k3n");
    assert!(request.starts_with("GET /api/v1/notifications?unread=true HTTP/1.1\r\n"));
    assert!(request.contains("Host: 127.0.0.1:7899\r\n"));
    assert!(request.contains("Authorization: Bearer t0k3n\r\n"));
    assert!(request.ends_with("Connection: close\r\n\r\n"));
    // 只出现一次：多一处就多一处泄漏面（日志、错误消息都不该有它）。
    assert_eq!(request.matches("t0k3n").count(), 1);
    // 端口来自壳层的生效值，不是硬编码的 7788。
    assert!(build_request(7789, "t0k3n").contains("Host: 127.0.0.1:7789\r\n"));
  }

  #[test]
  fn a_real_loopback_round_trip_yields_the_count() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind 临时端口");
    let port = listener.local_addr().expect("本地地址").port();
    let reply = response("200 OK", "", r#"{"items":[{"id":"n1"}],"unread_count":3}"#);
    let server = thread::spawn(move || {
      let mut seen = Vec::new();
      if let Ok((mut client, _)) = listener.accept() {
        // 把请求读到 \r\n\r\n 再回，免得对端被 EPIPE 打断。收到的字节只用于断言，不打日志。
        let mut byte = [0u8; 1];
        while !seen.ends_with(b"\r\n\r\n".as_slice()) {
          if client.read(&mut byte).unwrap_or(0) == 0 {
            break;
          }
          seen.push(byte[0]);
        }
        let _ = client.write_all(&reply);
        let _ = client.flush();
      }
      seen
    });

    assert_eq!(fetch_unread_count(port, "fake-token"), Ok(3));

    let seen = server.join().expect("应答线程");
    let text = String::from_utf8_lossy(&seen).to_string();
    assert!(text.starts_with("GET /api/v1/notifications?unread=true HTTP/1.1\r\n"));
    assert!(text.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
    assert!(text.contains("Connection: close"));
  }

  #[test]
  fn an_unreachable_service_and_a_refused_connection_both_report_failure() {
    // 占一个端口再放开：拿到一个「大概率没人听」的端口，连不上就是 Err——
    // 关键是这条路径不 panic，托盘据此切态。
    let port = {
      let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
      listener.local_addr().expect("本地地址").port()
    };
    let outcome = fetch_unread_count(port, "fake-token");
    assert!(outcome.is_err(), "连不上应判失败，却给了 {outcome:?}");

    // 端口没定（0）时连 socket 都不该创建。
    assert!(fetch_unread_count(0, "fake-token").is_err());
  }
}
