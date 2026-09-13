use std::path::{Path, PathBuf};

/// 编译期把仓库根的 sidecar 入口注入二进制（`env!("ATB_DEV_SIDECAR_ENTRY")`）。
///
/// 为什么走编译期而不是运行期猜 cwd：`cargo run` 的工作目录是 `src-tauri`，
/// 而打包后的 `.app` 根本没有仓库；两条路径分别对应
/// 「不打包就能验」（本期，见 sidecar::resolve_entry 第 3 档）与
/// 「安装包里带 sidecar」（阶段二，见第 2 档）。
fn dev_sidecar_entry(manifest_dir: &Path) -> Option<PathBuf> {
  let repo_root = manifest_dir
    .parent() // -> apps/desktop
    .and_then(Path::parent) // -> apps
    .and_then(Path::parent)?; // -> 仓库根
  let entry = repo_root.join("apps/api/dist/main.js");
  println!("cargo:rustc-env=ATB_REPO_ROOT={}", repo_root.display());
  println!("cargo:rustc-env=ATB_DEV_SIDECAR_ENTRY={}", entry.display());
  // 前端产物与 sidecar 入口都会被打进二进制，改了要重编。
  println!(
    "cargo:rerun-if-changed={}",
    repo_root.join("apps/web/dist").display()
  );
  Some(entry)
}

fn main() {
  println!("cargo:rerun-if-changed=tauri.conf.json");
  println!("cargo:rerun-if-changed=capabilities");
  println!("cargo:rerun-if-changed=icons");
  println!("cargo:rerun-if-changed=build.rs");
  let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
  let _ = dev_sidecar_entry(&manifest);
  tauri_build::build();
}
