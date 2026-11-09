//! Signed UI bundles. Native updates remain the responsibility of Tauri's updater.
use super::{app_data_dir, is_development};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, collections::HashMap, fs, io::{Cursor, Read}, sync::{Arc, Mutex, RwLock}, time::Duration};
use fs2::FileExt;
use tauri::{Assets, Manager, Runtime};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

const MAX_ARCHIVE: usize = 12 * 1024 * 1024;
const MAX_EXTRACTED: u64 = 32 * 1024 * 1024;
const SHELL_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
struct Bundle { files: HashMap<String, Vec<u8>>, revision: u64, encoded: String, signature: String }
#[derive(Deserialize)]
struct Manifest { shell_version: String, revision: u64 }
#[derive(Serialize, Deserialize)]
struct Cache { data: String, signature: String }

#[derive(Default)]
struct Inner { active: Option<Bundle>, staged: Option<Bundle>, pending: bool, lock: Option<fs::File> }
pub(super) struct UiState { inner: Mutex<Inner>, files: RwLock<Option<HashMap<String, Vec<u8>>>> }

fn cache_path(name: &str) -> std::path::PathBuf { app_data_dir().join("ui-updates").join(name) }
fn verify(data: &[u8], signature: &str) -> Result<Bundle, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).map_err(|_| "更新公钥配置无效")?;
    let key = config["plugins"]["updater"]["pubkey"].as_str().ok_or("缺少更新公钥")?;
    verify_with_key(data, signature, key, SHELL_VERSION)
}
fn verify_with_key(data: &[u8], signature: &str, key: &str, expected_shell: &str) -> Result<Bundle, String> {
    if data.len() > MAX_ARCHIVE || signature.len() > 4096 { return Err("界面更新包过大".into()); }
    let key = String::from_utf8(STANDARD.decode(key).map_err(|_| "更新公钥格式无效")?).map_err(|_| "更新公钥格式无效")?;
    let sig = String::from_utf8(STANDARD.decode(signature.trim()).map_err(|_| "更新签名格式无效")?).map_err(|_| "更新签名格式无效")?;
    let key = minisign_verify::PublicKey::decode(&key).map_err(|_| "更新公钥无效")?;
    let sig = minisign_verify::Signature::decode(&sig).map_err(|_| "更新签名无效")?;
    key.verify(data, &sig, true).map_err(|_| "界面更新签名校验失败")?;
    let mut archive = zip::ZipArchive::new(Cursor::new(data)).map_err(|_| "界面更新包格式无效")?;
    if archive.len() > 512 { return Err("界面更新包含过多文件".into()); }
    let mut files = HashMap::new(); let mut total = 0u64; let mut manifest = None;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|_| "无法读取界面更新")?;
        if file.is_dir() { continue; }
        let name = file.name().map_err(|_| "界面更新文件名无效")?.to_string();
        if name.contains('\\') || name.starts_with('/') || name.split('/').any(|part| part == ".." || part == "." || part.is_empty()) { return Err("界面更新文件路径无效".into()); }
        if name != "manifest.json" && name != "index.html" && !name.starts_with("assets/") { return Err("界面更新包含不支持的文件".into()); }
        total = total.checked_add(file.size()).ok_or("界面更新文件过大")?;
        if total > MAX_EXTRACTED { return Err("界面更新解压后过大".into()); }
        let size = file.size(); let mut bytes = Vec::new(); (&mut file).take(size + 1).read_to_end(&mut bytes).map_err(|_| "无法读取界面更新文件")?;
        if bytes.len() as u64 != size { return Err("界面更新文件大小无效".into()); }
        if name == "manifest.json" { if manifest.is_some() { return Err("界面更新清单重复".into()); } manifest = Some(serde_json::from_slice::<Manifest>(&bytes).map_err(|_| "界面更新清单无效")?); }
        else if files.insert(format!("/{name}"), bytes).is_some() { return Err("界面更新文件重复".into()); }
    }
    let manifest = manifest.ok_or("界面更新缺少清单")?;
    if manifest.shell_version != expected_shell || manifest.revision == 0 || !files.contains_key("/index.html") { return Err("界面更新与当前应用版本不兼容".into()) }
    Ok(Bundle { files, revision: manifest.revision, encoded: STANDARD.encode(data), signature: signature.trim().to_string() })
}

fn write_cache(path: &std::path::Path, bundle: &Bundle) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("缓存路径无效")?).map_err(|_| "无法创建更新缓存")?;
    let cache = Cache { data: bundle.encoded.clone(), signature: bundle.signature.clone() };
    let bytes = serde_json::to_vec(&cache).map_err(|_| "无法生成更新缓存")?;
    fs::write(path, bytes).map_err(|_| "无法保存界面更新".to_string())
}
fn load_cache(path: &std::path::Path) -> Option<Bundle> {
    load_cache_with(path, verify)
}
fn load_cache_with(path: &std::path::Path, verifier: impl Fn(&[u8], &str) -> Result<Bundle, String>) -> Option<Bundle> {
    if fs::metadata(path).ok()?.len() > (MAX_ARCHIVE * 2) as u64 { return None; }
    let bytes = fs::read(path).ok()?;
    if bytes.len() > MAX_ARCHIVE * 2 { return None; }
    let cache: Cache = serde_json::from_slice(&bytes).ok()?;
    verifier(&STANDARD.decode(cache.data).ok()?, &cache.signature).ok()
}
fn recover_active(directory: &std::path::Path, loader: impl Fn(&std::path::Path) -> Option<Bundle>) -> Option<Bundle> {
    loader(&directory.join("active.json")).or_else(|| loader(&directory.join("active-backup.json")))
}

impl UiState {
    pub(super) fn new() -> Arc<Self> {
        let active = if is_development() { None } else { recover_active(&cache_path(""), load_cache) };
        // An unconfirmed bundle from a previous run is never used.
        let files = active.as_ref().map(|bundle| bundle.files.clone());
        Arc::new(Self { inner: Mutex::new(Inner { active, staged: None, pending: false, lock: None }), files: RwLock::new(files) })
    }
}

pub(super) struct Overlay<R: Runtime> { pub fallback: Box<dyn Assets<R>>, pub state: Arc<UiState> }
pub(super) struct EmptyAssets;
impl<R: Runtime> Assets<R> for EmptyAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> { None }
    fn iter(&self) -> Box<AssetsIter<'_>> { Box::new(std::iter::empty()) }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item=CspHash<'_>> + '_> { Box::new(std::iter::empty()) }
}
impl<R: Runtime> Assets<R> for Overlay<R> {
    fn setup(&self, app: &tauri::App<R>) { self.fallback.setup(app); }
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let files = self.state.files.read().ok()?;
        match files.as_ref() { Some(files) => files.get(key.as_ref()).cloned().map(Cow::Owned), None => self.fallback.get(key).map(|v| Cow::Owned(v.into_owned())) }
    }
    fn iter(&self) -> Box<AssetsIter<'_>> { self.fallback.iter() }
    fn csp_hashes(&self, path: &AssetKey) -> Box<dyn Iterator<Item=CspHash<'_>> + '_> { self.fallback.csp_hashes(path) }
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct UiUpdate { revision: u64 }

fn latest_revision(metadata: &serde_json::Value, current: u64) -> Option<u64> {
    let names: Vec<&str> = metadata["assets"].as_array().into_iter().flatten().filter_map(|asset| asset["name"].as_str()).collect();
    names.iter().filter_map(|name| name.strip_prefix("ui-")?.strip_suffix(".zip")?.parse::<u64>().ok())
        .filter(|revision| *revision > current && names.contains(&format!("ui-{revision}.zip.sig").as_str())).max()
}

fn fetch(state: &UiState) -> Result<Option<UiUpdate>, String> {
    if is_development() { return Ok(None); }
    let client = reqwest::blocking::Client::builder().user_agent("Northstar-Workbench").timeout(Duration::from_secs(25)).redirect(reqwest::redirect::Policy::custom(|attempt| {
        let host = attempt.url().host_str().unwrap_or("");
        if attempt.previous().len() < 5 && attempt.url().scheme() == "https" && ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(&host) { attempt.follow() } else { attempt.stop() }
    })).build().map_err(|_| "无法初始化界面更新")?;
    let endpoint = format!("https://api.github.com/repos/qx921310/northstar-workbench/releases/tags/ui-v{SHELL_VERSION}");
    let response = client.get(endpoint).send().map_err(|_| "无法检查界面更新")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Ok(None); }
    if !response.status().is_success() { return Err("无法检查界面更新".into()); }
    let mut metadata = Vec::new(); response.take(262145).read_to_end(&mut metadata).map_err(|_| "无法读取界面更新清单")?;
    if metadata.len() > 262144 { return Err("界面更新清单过大".into()); }
    let metadata: serde_json::Value = serde_json::from_slice(&metadata).map_err(|_| "界面更新清单无效")?;
    let (current, staged) = { let inner = state.inner.lock().map_err(|_| "更新状态不可用")?; (inner.active.as_ref().map_or(0, |active| active.revision), inner.staged.as_ref().map(|bundle| bundle.revision)) };
    let Some(revision) = latest_revision(&metadata, current) else { return Ok(None); };
    if staged == Some(revision) { return Ok(Some(UiUpdate { revision })); }
    let base = format!("https://github.com/qx921310/northstar-workbench/releases/download/ui-v{SHELL_VERSION}");
    let response = client.get(format!("{base}/ui-{revision}.zip")).send().map_err(|_| "无法检查界面更新")?;
    if !response.status().is_success() { return Err("无法下载界面更新".into()); }
    let mut bytes = Vec::new(); response.take((MAX_ARCHIVE + 1) as u64).read_to_end(&mut bytes).map_err(|_| "无法读取界面更新")?;
    let response = client.get(format!("{base}/ui-{revision}.zip.sig")).send().map_err(|_| "无法读取界面更新签名")?.error_for_status().map_err(|_| "无法读取界面更新签名")?;
    let mut sig = String::new(); response.take(4097).read_to_string(&mut sig).map_err(|_| "界面更新签名格式无效")?;
    let bundle = verify(&bytes, &sig)?;
    if bundle.revision != revision { return Err("界面更新版本不匹配".into()); }
    let mut inner = state.inner.lock().map_err(|_| "更新状态不可用")?;
    if inner.pending { return Err("界面更新正在进行".into()); }
    if bundle.revision <= inner.active.as_ref().map_or(0, |active| active.revision) { return Ok(None); }
    let revision = bundle.revision; inner.staged = Some(bundle);
    Ok(Some(UiUpdate { revision }))
}

#[tauri::command]
pub(super) async fn check_ui_update(state: tauri::State<'_, Arc<UiState>>) -> Result<Option<UiUpdate>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || fetch(&state)).await.map_err(|_| "界面更新检查失败")?
}

#[tauri::command]
pub(super) fn ui_update_ready(state: tauri::State<'_, Arc<UiState>>) -> Result<u64, String> {
    let mut inner = state.inner.lock().map_err(|_| "更新状态不可用")?;
    promote(&mut inner, &cache_path(""))
}

fn promote(inner: &mut Inner, directory: &std::path::Path) -> Result<u64, String> {
    if inner.pending {
        if let Some(active) = inner.active.as_ref() {
            if load_cache(&directory.join("active.json")).is_none() { write_cache(&directory.join("active.json"), active)?; }
        }
        let candidate = inner.staged.as_ref().ok_or("界面更新状态无效")?;
        // The old confirmed bundle remains available until the new one is written.
        write_cache(&directory.join("active-next.json"), candidate)?;
        let active = directory.join("active.json"); let backup = directory.join("active-backup.json");
        let _ = fs::remove_file(&backup);
        if active.exists() { fs::rename(&active, &backup).map_err(|_| "无法备份界面更新")?; }
        if fs::rename(directory.join("active-next.json"), &active).is_err() { let _ = fs::rename(&backup, &active); return Err("无法确认界面更新".into()); }
        inner.active = inner.staged.take(); inner.pending = false;
        let _ = fs::remove_file(directory.join("pending.json")); let _ = fs::remove_file(backup); inner.lock = None;
    }
    Ok(inner.active.as_ref().map_or(0, |bundle| bundle.revision))
}

fn rollback(inner: &mut Inner, files: &RwLock<Option<HashMap<String, Vec<u8>>>>) -> Result<bool, String> {
    if !inner.pending { return Ok(false); }
    *files.write().map_err(|_| "更新状态不可用")? = inner.active.as_ref().map(|bundle| bundle.files.clone());
    inner.pending = false; inner.staged = None;
    Ok(true)
}

#[tauri::command]
pub(super) fn apply_ui_update(app: tauri::AppHandle, state: tauri::State<'_, Arc<UiState>>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("无法刷新界面")?;
    let mut inner = state.inner.lock().map_err(|_| "更新状态不可用")?;
    if inner.pending { return Err("界面更新正在进行".into()); }
    let candidate = inner.staged.as_ref().ok_or("请先检查界面更新")?;
    fs::create_dir_all(cache_path("lock").parent().ok_or("更新路径无效")?).map_err(|_| "无法创建更新缓存")?;
    let lock = fs::OpenOptions::new().create(true).read(true).write(true).open(cache_path("lock")).map_err(|_| "无法打开更新锁")?;
    lock.try_lock_exclusive().map_err(|_| "另一个北极星窗口正在更新，请稍后重试")?;
    if load_cache(&cache_path("active.json")).is_some_and(|active| active.revision >= candidate.revision) { return Err("另一个窗口已更新界面，请重启此窗口".into()) }
    write_cache(&cache_path("pending.json"), candidate)?;
    *state.files.write().map_err(|_| "更新状态不可用")? = Some(candidate.files.clone());
    inner.pending = true; inner.lock = Some(lock); drop(inner);
    if window.eval("window.location.replace(window.location.pathname + '?_northstar_ui=' + Date.now())").is_err() {
        let mut inner = state.inner.lock().map_err(|_| "更新状态不可用")?;
        rollback(&mut inner, &state.files)?;
        let _ = fs::remove_file(cache_path("pending.json")); inner.lock = None;
        return Err("无法刷新界面，更新未生效".into());
    }
    let state = state.inner().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        if let Ok(mut inner) = state.inner.lock() {
            if rollback(&mut inner, &state.files).unwrap_or(false) {
                let _ = fs::remove_file(cache_path("pending.json")); inner.lock = None;
                let _ = window.eval("window.location.replace(window.location.pathname + '?_northstar_ui=' + Date.now())");
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = include_str!("../tests/fixtures/ui/fixture.pub");
    const DATA: &[u8] = include_bytes!("../tests/fixtures/ui/valid.zip");
    const SIG: &str = include_str!("../tests/fixtures/ui/valid.zip.sig");
    #[test]
    fn verifies_a_signed_compatible_bundle_and_rejects_tampering() {
        let result = verify_with_key(DATA, SIG, KEY.trim(), "test-shell").unwrap();
        assert_eq!(result.revision, 1);
        assert!(result.files.contains_key("/index.html"));
        assert!(result.files.contains_key("/assets/test.js"));
        let mut corrupted = DATA.to_vec(); corrupted[10] ^= 1;
        assert!(verify_with_key(&corrupted, SIG, KEY.trim(), "test-shell").is_err());
        assert!(verify_with_key(DATA, SIG, KEY.trim(), "different-shell").is_err());
    }
    #[test]
    fn rejects_signed_bad_paths_and_incompatible_shells() {
        let path = verify_with_key(include_bytes!("../tests/fixtures/ui/bad-path.zip"), include_str!("../tests/fixtures/ui/bad-path.zip.sig"), KEY.trim(), "test-shell");
        assert!(path.is_err());
        let wrong = verify_with_key(include_bytes!("../tests/fixtures/ui/wrong-shell.zip"), include_str!("../tests/fixtures/ui/wrong-shell.zip.sig"), KEY.trim(), "test-shell");
        assert!(wrong.is_err());
    }
    #[test]
    fn active_assets_are_served_without_mixing_the_previous_bundle() {
        let bundle = verify_with_key(DATA, SIG, KEY.trim(), "test-shell").unwrap();
        let state = Arc::new(UiState { inner: Mutex::new(Inner::default()), files: RwLock::new(Some(bundle.files)) });
        let overlay: Overlay<tauri::Wry> = Overlay { fallback: Box::new(EmptyAssets), state };
        assert!(overlay.get(&AssetKey::from("index.html")).is_some());
        assert!(overlay.get(&AssetKey::from("assets/unknown.js")).is_none());
    }
    #[test]
    fn unconfirmed_update_rolls_back_to_previous_assets() {
        let old = verify_with_key(DATA, SIG, KEY.trim(), "test-shell").unwrap();
        let mut next = old.clone(); next.files.insert("/index.html".into(), b"new".to_vec());
        let files = RwLock::new(Some(next.files.clone()));
        let mut inner = Inner { active: Some(old.clone()), staged: Some(next), pending: true, lock: None };
        assert!(rollback(&mut inner, &files).unwrap());
        assert!(!inner.pending && inner.staged.is_none());
        assert_eq!(files.read().unwrap().as_ref().unwrap().get("/index.html"), old.files.get("/index.html"));
        assert!(!rollback(&mut inner, &files).unwrap());
    }
    #[test]
    fn only_ready_updates_become_confirmed_cache() {
        let bundle = verify_with_key(DATA, SIG, KEY.trim(), "test-shell").unwrap();
        let path = std::env::temp_dir().join(format!("northstar-ui-test-{}", super::super::random_url_safe(16)));
        fs::create_dir_all(&path).unwrap();
        let mut inner = Inner { active: None, staged: Some(bundle.clone()), pending: true, lock: None };
        assert_eq!(promote(&mut inner, &path).unwrap(), 1);
        assert!(!inner.pending && inner.staged.is_none());
        let record: Cache = serde_json::from_slice(&fs::read(path.join("active.json")).unwrap()).unwrap();
        assert_eq!(record.data, bundle.encoded);
        fs::remove_file(path.join("active.json")).unwrap();
        fs::remove_dir(path).unwrap();
    }
    #[test]
    fn recovers_confirmed_backup_but_never_pending_bundle() {
        let bundle = verify_with_key(DATA, SIG, KEY.trim(), "test-shell").unwrap();
        let path = std::env::temp_dir().join(format!("northstar-ui-recovery-{}", super::super::random_url_safe(16)));
        fs::create_dir_all(&path).unwrap();
        let loader = |file: &std::path::Path| load_cache_with(file, |data, signature| verify_with_key(data, signature, KEY.trim(), "test-shell"));
        write_cache(&path.join("pending.json"), &bundle).unwrap();
        assert!(recover_active(&path, loader).is_none());
        fs::write(path.join("active.json"), b"corrupt").unwrap();
        write_cache(&path.join("active-backup.json"), &bundle).unwrap();
        assert_eq!(recover_active(&path, loader).unwrap().revision, 1);
        for file in ["pending.json", "active.json", "active-backup.json"] { fs::remove_file(path.join(file)).unwrap(); }
        fs::remove_dir(path).unwrap();
    }
    #[test]
    fn release_metadata_only_selects_new_complete_pairs() {
        let metadata = serde_json::json!({"assets":[{"name":"ui-1.zip"},{"name":"ui-1.zip.sig"},{"name":"ui-2.zip"},{"name":"ui-3.zip"},{"name":"ui-3.zip.sig"},{"name":"ui-evil.zip"}]});
        assert_eq!(latest_revision(&metadata, 0), Some(3));
        assert_eq!(latest_revision(&metadata, 3), None);
    }
    #[test]
    fn locally_built_release_bundle_verifies_when_requested() {
        let Ok(path) = std::env::var("NORTHSTAR_UI_BUNDLE_TEST") else { return; };
        let data = fs::read(&path).unwrap();
        let signature = fs::read_to_string(format!("{path}.sig")).unwrap();
        let bundle = verify(&data, &signature).expect("production-key signed UI bundle must verify");
        assert!(bundle.revision > 0);
    }
    #[test]
    fn another_instance_cannot_apply_an_update_at_the_same_time() {
        let path = std::env::temp_dir().join(format!("northstar-ui-lock-{}", super::super::random_url_safe(16)));
        let first = fs::OpenOptions::new().create_new(true).read(true).write(true).open(&path).unwrap();
        let second = fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
        first.try_lock_exclusive().unwrap();
        assert!(second.try_lock_exclusive().is_err());
        drop(first);
        second.try_lock_exclusive().unwrap();
        drop(second);
        fs::remove_file(path).unwrap();
    }
}
