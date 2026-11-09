use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::form_urlencoded;
use tauri::Manager;

static GMAIL_AUTH: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    name: &'static str,
    installed: bool,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopContext {
    environment: &'static str,
    vault_path: String,
    task_directory: String,
    agents: Vec<AgentStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianTask {
    id: String,
    title: String,
    details: String,
    raw: String,
    completed: bool,
    reminder_at: Option<String>,
    file: String,
    line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianNote {
    file: String,
    title: String,
    preview: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshSshConfig {
    hosts: Vec<DshSshHost>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshSshHost {
    alias: String,
    host: String,
    port: Option<u16>,
    user: String,
    auth: DshSshAuth,
    description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshSshAuth {
    key_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceCheck {
    name: String,
    state: String,
    healthy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    id: String,
    name: String,
    description: String,
    reachable: bool,
    latency_ms: Option<u128>,
    hostname: Option<String>,
    uptime: Option<String>,
    load: Option<String>,
    memory: Option<String>,
    disk: Option<String>,
    checks: Vec<ServiceCheck>,
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MailAccount {
    id: String,
    provider: String,
    address: String,
    label: String,
    auth_type: String,
    connection_state: String,
}

mod imap_mail;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GmailSetup {
    configured: bool,
    client_id_hint: Option<String>,
    client_secret_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MailMessage {
    id: String,
    thread_id: String,
    from: String,
    subject: String,
    date: String,
    snippet: String,
    labels: Vec<String>,
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarCounts {
    open_tasks: usize,
    unread_mail: usize,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CustomService {
    id: String,
    name: String,
    target: String,
    kind: String,
}

#[derive(Serialize, Deserialize)]
struct MailSettings {
    gmail_client_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct GmailToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Users\\Public"))
}

fn is_development() -> bool {
    cfg!(any(debug_assertions, feature = "dev-isolation"))
}

fn app_data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
        .join(if is_development() { "Northstar Workbench Dev" } else { "Northstar Workbench" })
}

fn vault_path() -> PathBuf {
    if is_development() { app_data_dir().join("TestVault") } else { home_dir().join("ObsidianVault") }
}
fn task_directory() -> PathBuf {
    vault_path().join("待办事项")
}

fn mail_registry_path() -> PathBuf {
    app_data_dir().join("mail-accounts.json")
}

fn mail_settings_path() -> PathBuf {
    app_data_dir().join("mail-settings.json")
}

fn custom_services_path() -> PathBuf {
    app_data_dir().join("custom-services.json")
}

fn read_custom_services() -> Result<Vec<CustomService>, String> {
    let path = custom_services_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let source = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&source).map_err(|_| "自定义服务登记文件无效".to_string())
}

fn write_custom_services(services: &[CustomService]) -> Result<(), String> {
    let path = custom_services_path();
    let directory = path
        .parent()
        .ok_or_else(|| "自定义服务登记路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(services).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn read_mail_settings() -> Result<MailSettings, String> {
    let path = mail_settings_path();
    if !path.exists() {
        return Ok(MailSettings {
            gmail_client_id: None,
        });
    }
    let source = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&source).map_err(|_| "邮箱设置文件无效".to_string())
}

fn write_mail_settings(settings: &MailSettings) -> Result<(), String> {
    let path = mail_settings_path();
    let directory = path
        .parent()
        .ok_or_else(|| "邮箱设置路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn valid_google_client_id(value: &str) -> bool {
    let value = value.trim();
    value.len() > 32
        && value.ends_with(".apps.googleusercontent.com")
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.'))
}

fn gmail_token_entry(account_id: &str) -> Result<keyring::Entry, String> {
    #[cfg(not(windows))]
    { let _ = account_id; return Err("当前系统尚未配置安全凭据存储，不能连接邮箱".into()); }
    #[cfg(windows)]
    keyring::Entry::new(gmail_credential_service(), account_id)
        .map_err(|error| format!("无法打开 Windows 凭据管理器：{error}"))
}

fn gmail_credential_service() -> &'static str {
    if is_development() { "Northstar Workbench Dev Gmail" } else { "Northstar Workbench Gmail" }
}

fn gmail_client_secret_entry(client_id: &str) -> Result<keyring::Entry, String> {
    #[cfg(not(windows))]
    { let _ = client_id; return Err("当前系统尚未配置安全凭据存储，不能连接邮箱".into()); }
    #[cfg(windows)]
    keyring::Entry::new(gmail_oauth_credential_service(), client_id).map_err(|_| "无法打开客户端密钥存储".to_string())
}

fn gmail_oauth_credential_service() -> &'static str {
    if is_development() { "Northstar Workbench Dev Google OAuth" } else { "Northstar Workbench Google OAuth" }
}

fn read_gmail_client_secret(client_id: &str) -> Result<Option<String>, String> {
    match gmail_client_secret_entry(client_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取客户端密钥，请检查 Windows 凭据管理器".into()),
    }
}

fn token_parameters_with_secret<'a>(mut parameters: Vec<(&'a str, &'a str)>, secret: Option<&'a str>) -> Vec<(&'a str, &'a str)> {
    if let Some(secret) = secret { parameters.push(("client_secret", secret)); }
    parameters
}

fn read_gmail_token(account_id: &str) -> Result<GmailToken, String> {
    let value = gmail_token_entry(account_id)?
        .get_password()
        .map_err(|_| "未找到 Gmail 授权凭据，请重新连接".to_string())?;
    serde_json::from_str(&value).map_err(|_| "Gmail 授权凭据无效，请重新连接".to_string())
}

fn write_gmail_token(account_id: &str, token: &GmailToken) -> Result<(), String> {
    let value = serde_json::to_string(token).map_err(|error| error.to_string())?;
    gmail_token_entry(account_id)?
        .set_password(&value)
        .map_err(|error| format!("无法保存 Gmail 授权凭据：{error}"))
}

fn now_seconds() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs())
}

fn random_url_safe(length: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), length)
}

fn gmail_callback(listener: TcpListener, expected_state: &str, cancelled: &AtomicBool) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    let (mut stream, _) = loop {
        if cancelled.load(Ordering::SeqCst) { return Err("已取消 Gmail 授权".into()); }
        if started.elapsed() >= Duration::from_secs(180) { return Err("等待 Google 授权超时，请检查浏览器提示后重试".into()); }
        match listener.accept() {
            Ok(connection) => break connection,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(format!("等待 Google 授权回调失败：{error}")),
        }
    };
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|error| error.to_string())?;
    let mut request = [0_u8; 8192];
    let bytes = stream
        .read(&mut request)
        .map_err(|error| error.to_string())?;
    let first_line = String::from_utf8_lossy(&request[..bytes])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Google 授权回调格式无效".to_string())?;
    let query = path
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or_default();
    let params: std::collections::HashMap<String, String> =
        form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();
    if let Some(error) = params.get("error") {
        return Err(format!("Google 授权未完成：{error}"));
    }
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Err("Google 授权状态校验失败，请重试".to_string());
    }
    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| "Google 未返回授权码".to_string())?;
    let response = "<html><meta charset=\"utf-8\"><body><h2>北极星已收到授权码</h2><p>邮箱连接尚未完成，请返回北极星查看最终结果。此页面可以关闭。</p></body></html>";
    let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).as_bytes());
    Ok(code)
}

fn gmail_token_request(parameters: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    gmail_token_request_to("https://oauth2.googleapis.com/token", parameters)
}

fn gmail_token_request_to(endpoint: &str, parameters: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|_| "无法初始化 Google 连接".to_string())?
        .post(endpoint)
        .form(parameters)
        .send()
        .map_err(|_| "无法连接 Google 令牌服务，请检查网络后重试".to_string())?;
    let status = response.status();
    if !status.is_success() {
        let value = response.json::<serde_json::Value>().unwrap_or_default();
        return Err(gmail_token_error(status.as_u16(), value.get("error").and_then(|v| v.as_str()), value.get("error_description").and_then(|v| v.as_str())));
    }
    response
        .json()
        .map_err(|error| format!("Google 令牌响应无效：{error}"))
}

fn gmail_token_error(status: u16, code: Option<&str>, description: Option<&str>) -> String {
    let description = description.unwrap_or_default().to_ascii_lowercase();
    if description.contains("client_secret") && (description.contains("missing") || description.contains("required")) {
        return format!("Google 令牌交换失败（HTTP {status}）：Google 提示此客户端需要 client_secret；请反馈此提示，勿发送密钥。");
    }
    let (safe_code, detail) = match code {
        Some("invalid_grant") => ("invalid_grant", "授权码无效、已过期或与本次请求不匹配；请重新开始授权。"),
        Some("invalid_client") => ("invalid_client", "Google 未接受客户端配置；请确认客户端 ID 和密钥属于同一个桌面应用。"),
        Some("invalid_request") => ("invalid_request", "Google 未接受授权请求参数；请重试，如仍失败请反馈此错误代码。"),
        Some("unauthorized_client") => ("unauthorized_client", "当前客户端不支持此授权方式；请检查 Google Cloud 中的客户端类型。"),
        Some("access_denied") => ("access_denied", "Google 未批准本次授权；请检查账户和应用授权设置。"),
        Some("invalid_scope") => ("invalid_scope", "Google 未接受请求的邮箱权限；请检查 Gmail API 和授权范围设置。"),
        _ => ("unknown_error", "Google 未提供可识别的错误代码；请稍后重试。"),
    };
    format!("Google 令牌交换失败（HTTP {status}，{safe_code}）：{detail}")
}

fn refresh_gmail_token(account_id: &str, client_id: &str) -> Result<GmailToken, String> {
    let current = read_gmail_token(account_id)?;
    if current.expires_at > now_seconds()? + 60 {
        return Ok(current);
    }
    let refresh_token = current
        .refresh_token
        .as_deref()
        .ok_or_else(|| "Gmail 授权已过期，请重新连接".to_string())?;
    let secret = read_gmail_client_secret(client_id)?;
    let parameters = token_parameters_with_secret(vec![
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ], secret.as_deref());
    let value = gmail_token_request(&parameters)?;
    let access_token = value["access_token"]
        .as_str()
        .ok_or_else(|| "Google 未返回访问令牌".to_string())?
        .to_string();
    let expires_in = value["expires_in"].as_u64().unwrap_or(3600);
    let token = GmailToken {
        access_token,
        refresh_token: current.refresh_token,
        expires_at: now_seconds()? + expires_in,
    };
    write_gmail_token(account_id, &token)?;
    Ok(token)
}

fn gmail_api_get(account_id: &str, path: &str) -> Result<serde_json::Value, String> {
    let settings = read_mail_settings()?;
    let client_id = settings
        .gmail_client_id
        .ok_or_else(|| "请先配置 Google OAuth Client ID".to_string())?;
    let token = refresh_gmail_token(account_id, &client_id)?;
    reqwest::blocking::Client::new()
        .get(format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/{path}"
        ))
        .bearer_auth(token.access_token)
        .send()
        .map_err(|error| format!("请求 Gmail 失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Gmail 请求被拒绝：{error}"))?
        .json()
        .map_err(|error| format!("Gmail 响应无效：{error}"))
}

fn gmail_header(value: &serde_json::Value, name: &str) -> String {
    value["payload"]["headers"]
        .as_array()
        .and_then(|headers| {
            headers.iter().find_map(|header| {
                (header["name"].as_str()?.eq_ignore_ascii_case(name))
                    .then(|| header["value"].as_str().unwrap_or_default().to_string())
            })
        })
        .unwrap_or_default()
}

fn gmail_part_body(value: &serde_json::Value) -> Option<String> {
    let mime_type = value["mimeType"].as_str().unwrap_or_default();
    if mime_type == "text/plain" {
        if let Some(data) = value["body"]["data"].as_str() {
            return URL_SAFE_NO_PAD
                .decode(data)
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).to_string());
        }
    }
    value["parts"]
        .as_array()
        .and_then(|parts| parts.iter().find_map(gmail_part_body))
}

fn mail_message_from_gmail(value: &serde_json::Value, include_body: bool) -> MailMessage {
    MailMessage {
        id: value["id"].as_str().unwrap_or_default().to_string(),
        thread_id: value["threadId"].as_str().unwrap_or_default().to_string(),
        from: gmail_header(value, "From"),
        subject: gmail_header(value, "Subject"),
        date: gmail_header(value, "Date"),
        snippet: value["snippet"].as_str().unwrap_or_default().to_string(),
        labels: value["labelIds"]
            .as_array()
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(|label| label.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        body: include_body
            .then(|| gmail_part_body(&value["payload"]))
            .flatten(),
    }
}

fn first_existing(candidates: &[PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.display().to_string())
}

fn detect_agents(home: &Path) -> Vec<AgentStatus> {
    let app_data = home.join("AppData").join("Roaming");
    vec![
        AgentStatus {
            name: "DSH",
            installed: first_existing(&[home.join(".dsh")]).is_some(),
            path: first_existing(&[home.join(".dsh")]),
        },
        AgentStatus {
            name: "Pi",
            installed: first_existing(&[app_data.join("npm").join("pi.cmd"), home.join(".pi")])
                .is_some(),
            path: first_existing(&[app_data.join("npm").join("pi.cmd"), home.join(".pi")]),
        },
        AgentStatus {
            name: "Codex",
            installed: first_existing(&[
                app_data.join("npm").join("codex.cmd"),
                home.join(".codex"),
            ])
            .is_some(),
            path: first_existing(&[app_data.join("npm").join("codex.cmd"), home.join(".codex")]),
        },
    ]
}

fn desktop_context_from_home(home: &Path) -> DesktopContext {
    let vault = home.join("ObsidianVault");
    let tasks = vault.join("待办事项");
    DesktopContext {
        environment: if is_development() { "development" } else { "production" },
        vault_path: vault.display().to_string(),
        task_directory: tasks.display().to_string(),
        agents: detect_agents(home),
    }
}

fn markdown_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if ![".obsidian", ".git", "node_modules"].contains(&name) {
                markdown_files(&path, files)?;
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
            files.push(path);
        }
    }
    Ok(())
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn task_from_line(file: &str, line: usize, raw: &str) -> Option<ObsidianTask> {
    let trimmed = raw.trim_start();
    let (completed, title) = if let Some(title) = trimmed.strip_prefix("- [ ] ") {
        (false, title)
    } else if let Some(title) = trimmed
        .strip_prefix("- [x] ")
        .or_else(|| trimmed.strip_prefix("- [X] "))
    {
        (true, title)
    } else {
        return None;
    };
    let (title, reminder_at) = split_task_reminder(title);
    let (title, details) = match title.rsplit_once(" <!-- northstar-detail:") {
        Some((name, value)) if value.ends_with(" -->") => {
            let encoded = value.trim_end_matches(" -->");
            match URL_SAFE_NO_PAD.decode(encoded).ok().and_then(|bytes| String::from_utf8(bytes).ok()) {
                Some(details) => {
                    let visible_details = details.split_whitespace().collect::<Vec<_>>().join(" ");
                    let suffix = format!(" — {visible_details}");
                    (name.strip_suffix(&suffix).unwrap_or(name).to_string(), details)
                },
                None => (title.clone(), String::new()),
            }
        }
        _ => (title, String::new()),
    };
    Some(ObsidianTask {
        id: format!("{file}:{line}"),
        title,
        details,
        raw: raw.to_string(),
        completed,
        reminder_at,
        file: file.to_string(),
        line,
    })
}

fn split_task_reminder(value: &str) -> (String, Option<String>) {
    const MARKER: &str = "<!-- northstar-remind:";
    let Some(index) = value.rfind(MARKER) else {
        return (value.trim().to_string(), None);
    };
    let candidate = &value[index + MARKER.len()..];
    let Some(reminder) = candidate.strip_suffix("-->") else {
        return (value.trim().to_string(), None);
    };
    let reminder = reminder.trim();
    if valid_reminder_at(reminder) {
        (
            value[..index].trim_end().to_string(),
            Some(reminder.to_string()),
        )
    } else {
        (value.trim().to_string(), None)
    }
}

fn valid_reminder_at(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 16
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13) || byte.is_ascii_digit())
}

fn safe_reminder_at(value: Option<String>) -> Result<Option<String>, String> {
    match value {
        Some(value) if valid_reminder_at(value.trim()) => Ok(Some(value.trim().to_string())),
        Some(_) => Err("提醒时间必须精确到日期和分钟".to_string()),
        None => Ok(None),
    }
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(value);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("路径必须位于 Obsidian Vault 内".to_string());
    }
    Ok(candidate.to_path_buf())
}

fn safe_note_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() || name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("名称不能为空且不能包含 Windows 保留字符".to_string());
    }
    Ok(name.to_string())
}

fn mail_auth_type(provider: &str) -> Option<&'static str> {
    match provider {
        "gmail" | "outlook" => Some("oauth"),
        "qq" | "imap" => Some("app_password"),
        _ => None,
    }
}

fn read_mail_accounts_at(path: &Path) -> Result<Vec<MailAccount>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let source = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&source).map_err(|_| "邮箱账户登记文件无效".to_string())
}

fn read_mail_accounts() -> Result<Vec<MailAccount>, String> {
    read_mail_accounts_at(&mail_registry_path())
}

fn write_mail_accounts_at(path: &Path, accounts: &[MailAccount]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "邮箱账户路径无效".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(accounts).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn write_mail_accounts(accounts: &[MailAccount]) -> Result<(), String> {
    write_mail_accounts_at(&mail_registry_path(), accounts)
}

fn new_mail_account(
    provider: String,
    address: String,
    label: String,
    existing: &[MailAccount],
    timestamp: u128,
) -> Result<MailAccount, String> {
    let provider = provider.trim().to_lowercase();
    let auth_type = mail_auth_type(&provider).ok_or_else(|| "不支持的邮箱类型".to_string())?;
    let address = address.trim().to_lowercase();
    if !address.contains('@') || address.contains(char::is_whitespace) {
        return Err("请输入有效的邮箱地址".to_string());
    }
    if existing.iter().any(|account| account.address == address) {
        return Err("该邮箱已登记".to_string());
    }
    let label = if label.trim().is_empty() {
        address.clone()
    } else {
        safe_note_name(&label)?
    };
    Ok(MailAccount {
        id: format!("{provider}-{timestamp}"),
        provider,
        address,
        label,
        auth_type: auth_type.to_string(),
        connection_state: "setup_required".to_string(),
    })
}

fn expected_checks(alias: &str) -> Vec<&'static str> {
    match alias {
        "hermes" => vec!["dsh-feishu"],
        "seoul" => vec!["openclaw-gateway", "docker", "new-api"],
        _ => Vec::new(),
    }
}

fn parse_probe(output: &str, key: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.strip_prefix(&format!("__{key}=")).map(str::to_owned))
        .filter(|value| !value.is_empty())
}

fn probe_service(host: DshSshHost) -> ServiceStatus {
    let checks = expected_checks(&host.alias);
    let name = match host.alias.as_str() {
        "hermes" => "Hermes · 搬瓦工".to_string(),
        "seoul" => "Seoul · 腾讯云".to_string(),
        _ => host.alias.clone(),
    };
    let description = host
        .description
        .unwrap_or_else(|| format!("{}@{}", host.user, host.host));
    let Some(key_path) = host.auth.key_path else {
        return ServiceStatus {
            id: host.alias,
            name,
            description,
            reachable: false,
            latency_ms: None,
            hostname: None,
            uptime: None,
            load: None,
            memory: None,
            disk: None,
            checks: Vec::new(),
            error: Some("DSH SSH 登记缺少密钥路径".to_string()),
        };
    };
    let remote = r#"printf '__host=%s\n' "$(hostname)"; printf '__uptime=%s\n' "$(uptime -p)"; printf '__load=%s\n' "$(cut -d ' ' -f1-3 /proc/loadavg)"; printf '__memory=%s\n' "$(free -m | awk '/Mem:/ {printf "%s/%sMB", $3, $2}')"; printf '__disk=%s\n' "$(df -P / | awk 'NR==2 {printf "%s used, %s free", $5, $4}')"; for svc in dsh-feishu openclaw-gateway docker; do printf '__%s=%s\n' "$svc" "$(systemctl is-active "$svc" 2>/dev/null || true)"; done; printf '__new-api=%s\n' "$(docker inspect --format='{{.State.Status}}' new-api 2>/dev/null || true)""#;
    let started = Instant::now();
    let output = hidden_command("ssh")
        .args([
            "-i",
            &key_path,
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=12",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ])
        .arg("-p")
        .arg(host.port.unwrap_or(22).to_string())
        .arg(format!("{}@{}", host.user, host.host))
        .arg(remote)
        .output();
    let latency_ms = started.elapsed().as_millis();
    match output {
        Ok(result) if result.status.success() => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let parsed_checks = checks
                .iter()
                .map(|check| {
                    let state =
                        parse_probe(&stdout, check).unwrap_or_else(|| "unavailable".to_string());
                    ServiceCheck {
                        name: check.to_string(),
                        healthy: matches!(state.as_str(), "active" | "running"),
                        state,
                    }
                })
                .collect();
            ServiceStatus {
                id: host.alias,
                name,
                description,
                reachable: true,
                latency_ms: Some(latency_ms),
                hostname: parse_probe(&stdout, "host"),
                uptime: parse_probe(&stdout, "uptime"),
                load: parse_probe(&stdout, "load"),
                memory: parse_probe(&stdout, "memory"),
                disk: parse_probe(&stdout, "disk"),
                checks: parsed_checks,
                error: None,
            }
        }
        Ok(result) => ServiceStatus {
            id: host.alias,
            name,
            description,
            reachable: false,
            latency_ms: Some(latency_ms),
            hostname: None,
            uptime: None,
            load: None,
            memory: None,
            disk: None,
            checks: Vec::new(),
            error: Some(String::from_utf8_lossy(&result.stderr).trim().to_string()),
        },
        Err(error) => ServiceStatus {
            id: host.alias,
            name,
            description,
            reachable: false,
            latency_ms: Some(latency_ms),
            hostname: None,
            uptime: None,
            load: None,
            memory: None,
            disk: None,
            checks: Vec::new(),
            error: Some(format!("无法启动 SSH：{error}")),
        },
    }
}

fn valid_custom_service(kind: &str, target: &str) -> Result<(), String> {
    match kind {
        "http" => {
            let url =
                url::Url::parse(target.trim()).map_err(|_| "HTTP 地址格式无效".to_string())?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err("HTTP 地址必须以 http:// 或 https:// 开头".to_string());
            }
        }
        "tcp" => {
            let mut addresses = target
                .trim()
                .to_socket_addrs()
                .map_err(|_| "TCP 地址应为 主机:端口，例如 example.com:443".to_string())?;
            if addresses.next().is_none() {
                return Err("TCP 地址应包含可解析的主机和端口".to_string());
            }
        }
        _ => return Err("仅支持 HTTP(S) 或 TCP 探测".to_string()),
    }
    Ok(())
}

fn probe_custom_service(service: CustomService) -> ServiceStatus {
    let started = Instant::now();
    let result: Result<(), String> = match service.kind.as_str() {
        "http" => reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|error| error.to_string())
            .and_then(|client| {
                client
                    .get(&service.target)
                    .send()
                    .map_err(|error| error.to_string())
                    .and_then(|response| {
                        (response.status().is_success() || response.status().is_redirection())
                            .then_some(())
                            .ok_or_else(|| format!("HTTP {}", response.status()))
                    })
            }),
        "tcp" => service
            .target
            .to_socket_addrs()
            .map_err(|error| error.to_string())
            .and_then(|mut addresses| {
                let address = addresses
                    .next()
                    .ok_or_else(|| "无法解析 TCP 地址".to_string())?;
                TcpStream::connect_timeout(&address, Duration::from_secs(8))
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            }),
        _ => Err("未知探测类型".to_string()),
    };
    let latency_ms = started.elapsed().as_millis();
    let healthy = result.is_ok();
    ServiceStatus {
        id: service.id,
        name: service.name,
        description: service.target.clone(),
        reachable: healthy,
        latency_ms: Some(latency_ms),
        hostname: Some(service.target),
        uptime: None,
        load: None,
        memory: None,
        disk: None,
        checks: vec![ServiceCheck {
            name: service.kind.to_uppercase(),
            state: if healthy { "reachable" } else { "unavailable" }.to_string(),
            healthy,
        }],
        error: result.err(),
    }
}

#[tauri::command]
fn get_desktop_context() -> DesktopContext {
    let mut context = desktop_context_from_home(&home_dir());
    context.vault_path = vault_path().display().to_string();
    context.task_directory = task_directory().display().to_string();
    context
}

fn read_obsidian_tasks() -> Result<Vec<ObsidianTask>, String> {
    let root = task_directory();
    let mut files = Vec::new();
    markdown_files(&root, &mut files)?;
    let mut tasks = Vec::new();
    for path in files {
        let file = relative_display(&vault_path(), &path);
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        for (index, line) in content.lines().enumerate() {
            if let Some(task) = task_from_line(&file, index, line) {
                tasks.push(task);
            }
        }
    }
    Ok(tasks)
}

#[tauri::command]
async fn list_obsidian_tasks() -> Result<Vec<ObsidianTask>, String> {
    tauri::async_runtime::spawn_blocking(read_obsidian_tasks).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn create_obsidian_task(
    title: String,
    details: String,
    reminder_at: Option<String>,
) -> Result<ObsidianTask, String> {
    let title = safe_note_name(&title)?;
    if title.contains(['\r', '\n']) { return Err("标题不能换行".into()); }
    let reminder_at = safe_reminder_at(reminder_at)?;
    let directory = task_directory();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("Northstar.md");
    let mut content = if path.exists() {
        fs::read_to_string(&path).map_err(|error| error.to_string())?
    } else {
        "# Northstar 待办\n\n".to_string()
    };
    if !content.ends_with('\n') {
        content.push('\n');
    }
    let line = content.lines().count();
    let metadata = reminder_at
        .as_ref()
        .map(|value| format!(" <!-- northstar-remind:{value} -->"))
        .unwrap_or_default();
    let details = details.trim().to_string();
    let detail_marker = format!(" <!-- northstar-detail:{} -->", URL_SAFE_NO_PAD.encode(details.as_bytes()));
    let visible_details = details.split_whitespace().collect::<Vec<_>>().join(" ");
    let visible_details = if visible_details.is_empty() { String::new() } else { format!(" — {visible_details}") };
    content.push_str(&format!("- [ ] {title}{visible_details}{detail_marker}{metadata}\n"));
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(ObsidianTask {
        id: format!("待办事项/Northstar.md:{line}"),
        raw: format!("- [ ] {title}{visible_details}{detail_marker}{metadata}"),
        title,
        details,
        completed: false,
        reminder_at,
        file: "待办事项/Northstar.md".to_string(),
        line,
    })
}

#[tauri::command]
fn change_northstar_task(line: usize, expected: String, title: Option<String>, details: Option<String>, reminder_at: Option<String>) -> Result<(), String> {
    let path = task_directory().join("Northstar.md");
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = content.split_inclusive('\n').map(str::to_owned).collect();
    let source = lines.get(line).ok_or("待办已不存在，请刷新")?;
    let source_text = source.trim_end_matches(['\r', '\n']);
    if source_text != expected { return Err("待办已变化，请刷新后重试".into()); }
    if let Some(title) = title {
        let title = safe_note_name(&title)?;
        if title.contains(['\r', '\n']) { return Err("标题不能换行".into()); }
        let reminder = safe_reminder_at(reminder_at)?.map(|v| format!(" <!-- northstar-remind:{v} -->")).unwrap_or_default();
        let details = details.unwrap_or_default();
        let visible_details = details.split_whitespace().collect::<Vec<_>>().join(" ");
        let visible_details = if visible_details.is_empty() { String::new() } else { format!(" — {visible_details}") };
        let prefix = if source.trim_start().starts_with("- [x] ") || source.trim_start().starts_with("- [X] ") { "- [x] " } else if source.trim_start().starts_with("- [ ] ") { "- [ ] " } else { return Err("目标行不是待办".into()); };
        let ending = if source.ends_with("\r\n") { "\r\n" } else if source.ends_with('\n') { "\n" } else { "" };
        lines[line] = format!("{prefix}{title}{visible_details} <!-- northstar-detail:{} -->{reminder}{ending}", URL_SAFE_NO_PAD.encode(details.trim().as_bytes()));
    } else { lines.remove(line); }
    fs::write(path, lines.concat()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_obsidian_task_completion(file: String, line: usize, completed: bool) -> Result<(), String> {
    let relative = safe_relative(&file)?;
    let path = vault_path().join(relative);
    if !path.starts_with(task_directory())
        || path.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err("只能更新待办目录中的 Markdown 文件".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut lines: Vec<String> = content.lines().map(str::to_owned).collect();
    let source = lines
        .get_mut(line)
        .ok_or_else(|| "待办已不存在或文件已变化".to_string())?;
    let replacement = if completed { "- [x] " } else { "- [ ] " };
    if source.trim_start().starts_with("- [x] ")
        || source.trim_start().starts_with("- [X] ")
        || source.trim_start().starts_with("- [ ] ")
    {
        let indent: String = source
            .chars()
            .take_while(|character| character.is_whitespace())
            .collect();
        let title = source.trim_start()[6..].to_string();
        *source = format!("{indent}{replacement}{title}");
        fs::write(path, format!("{}\n", lines.join("\n"))).map_err(|error| error.to_string())?;
        Ok(())
    } else {
        Err("目标行不是 Markdown 待办".to_string())
    }
}

fn read_obsidian_notes(query: String) -> Result<Vec<ObsidianNote>, String> {
    let root = vault_path();
    let mut files = Vec::new();
    markdown_files(&root, &mut files)?;
    let query = query.trim().to_lowercase();
    let mut notes = Vec::new();
    for path in files {
        let file = relative_display(&root, &path);
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let title = content
            .lines()
            .find_map(|line| line.strip_prefix("# "))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("未命名笔记")
                    .to_string()
            });
        if query.is_empty()
            || title.to_lowercase().contains(&query)
            || content.to_lowercase().contains(&query)
        {
            let preview = content
                .lines()
                .find(|line| !line.trim().is_empty() && !line.starts_with('#'))
                .unwrap_or("空笔记")
                .trim()
                .chars()
                .take(96)
                .collect();
            notes.push(ObsidianNote {
                file,
                title,
                preview,
            });
        }
    }
    notes.sort_by(|left, right| left.title.cmp(&right.title));
    notes.truncate(100);
    Ok(notes)
}

#[tauri::command]
async fn list_obsidian_notes(query: String) -> Result<Vec<ObsidianNote>, String> {
    tauri::async_runtime::spawn_blocking(move || read_obsidian_notes(query)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn create_obsidian_note(directory: String, title: String) -> Result<ObsidianNote, String> {
    let directory = safe_relative(&directory)?;
    let title = safe_note_name(&title)?;
    let path = vault_path().join(directory).join(format!("{title}.md"));
    if path.exists() {
        return Err("同名笔记已存在".to_string());
    }
    let parent = path.parent().ok_or_else(|| "笔记路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::write(&path, format!("# {title}\n\n")).map_err(|error| error.to_string())?;
    Ok(ObsidianNote {
        file: relative_display(&vault_path(), &path),
        title,
        preview: "空笔记".to_string(),
    })
}

#[tauri::command]
fn create_obsidian_directory(path: String) -> Result<(), String> {
    let relative = safe_relative(&path)?;
    fs::create_dir_all(vault_path().join(relative)).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_mail_accounts() -> Result<Vec<MailAccount>, String> {
    read_mail_accounts()
}

#[tauri::command]
fn register_mail_account(
    provider: String,
    address: String,
    label: String,
) -> Result<MailAccount, String> {
    let mut accounts = read_mail_accounts()?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let account = new_mail_account(provider, address, label, &accounts, timestamp)?;
    accounts.push(account.clone());
    write_mail_accounts(&accounts)?;
    Ok(account)
}

fn read_sidebar_counts() -> Result<SidebarCounts, String> {
    let open_tasks = read_obsidian_tasks()?
        .into_iter()
        .filter(|task| !task.completed)
        .count();
    let unread_mail = read_mail_accounts()?
        .into_iter()
        .filter(|account| account.provider == "gmail" && account.connection_state == "connected")
        .find_map(|account| {
            gmail_api_get(
                &account.id,
                "messages?labelIds=INBOX&labelIds=UNREAD&maxResults=1",
            )
            .ok()
            .and_then(|value| value["resultSizeEstimate"].as_u64())
            .map(|count| count as usize)
        })
        .unwrap_or(0);
    Ok(SidebarCounts {
        open_tasks,
        unread_mail,
    })
}

#[tauri::command]
async fn get_sidebar_counts() -> Result<SidebarCounts, String> {
    tauri::async_runtime::spawn_blocking(read_sidebar_counts).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_gmail_setup() -> Result<GmailSetup, String> {
    let settings = read_mail_settings()?;
    let client_secret_configured = match settings.gmail_client_id.as_deref() {
        Some(client_id) => read_gmail_client_secret(client_id)?.is_some(),
        None => false,
    };
    let client_id_hint = settings.gmail_client_id.map(|value| {
        let prefix: String = value.chars().take(12).collect();
        format!("{prefix}…")
    });
    Ok(GmailSetup {
        configured: client_id_hint.is_some(),
        client_id_hint,
        client_secret_configured,
    })
}

#[tauri::command]
fn set_gmail_client_secret(client_secret: String) -> Result<GmailSetup, String> {
    let client_id = read_mail_settings()?.gmail_client_id.ok_or("请先配置 Google 客户端 ID")?;
    let secret = client_secret.trim();
    if secret.is_empty() || secret.contains(['\r', '\n']) { return Err("请输入有效的客户端密钥".into()); }
    gmail_client_secret_entry(&client_id)?.set_password(secret).map_err(|_| "无法保存客户端密钥至 Windows 凭据管理器".to_string())?;
    get_gmail_setup()
}

#[tauri::command]
fn set_gmail_client_id(client_id: String) -> Result<GmailSetup, String> {
    let client_id = client_id.trim();
    if !valid_google_client_id(client_id) {
        return Err(
            "Google OAuth Client ID 格式不正确，请使用 Desktop app 类型的 Client ID".to_string(),
        );
    }
    write_mail_settings(&MailSettings {
        gmail_client_id: Some(client_id.to_string()),
    })?;
    get_gmail_setup()
}

fn connect_gmail_blocking(cancelled: Arc<AtomicBool>) -> Result<MailAccount, String> {
    let settings = read_mail_settings()?;
    let client_id = settings
        .gmail_client_id
        .ok_or_else(|| "请先配置 Google OAuth Client ID".to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("无法启动本机 OAuth 回调端口：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let verifier = random_url_safe(96);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_url_safe(32);
    let mut query = form_urlencoded::Serializer::new(String::new());
    query.append_pair("client_id", &client_id);
    query.append_pair("redirect_uri", &redirect_uri);
    query.append_pair("response_type", "code");
    query.append_pair(
        "scope",
        "openid email https://www.googleapis.com/auth/gmail.readonly",
    );
    query.append_pair("access_type", "offline");
    query.append_pair("prompt", "consent");
    query.append_pair("code_challenge", &challenge);
    query.append_pair("code_challenge_method", "S256");
    query.append_pair("state", &state);
    let authorization_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?{}",
        query.finish()
    );
    hidden_command("rundll32")
        .args(["url.dll,FileProtocolHandler", &authorization_url])
        .spawn()
        .map_err(|error| format!("无法打开默认浏览器：{error}"))?;
    let code = gmail_callback(listener, &state, &cancelled)?;
    if cancelled.load(Ordering::SeqCst) { return Err("已取消 Gmail 授权".into()); }
    let secret = read_gmail_client_secret(&client_id)?;
    let parameters = token_parameters_with_secret(vec![
        ("client_id", &client_id),
        ("code", &code),
        ("code_verifier", &verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", &redirect_uri),
    ], secret.as_deref());
    let token_value = gmail_token_request(&parameters)?;
    let access_token = token_value["access_token"]
        .as_str()
        .ok_or_else(|| "Google 未返回访问令牌".to_string())?
        .to_string();
    let refresh_token = token_value["refresh_token"].as_str().map(str::to_string);
    let expires_in = token_value["expires_in"].as_u64().unwrap_or(3600);
    let user: serde_json::Value = reqwest::blocking::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|error| error.to_string())?
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&access_token)
        .send()
        .map_err(|error| format!("读取 Google 账户信息失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("Google 账户信息请求被拒绝：{error}"))?
        .json()
        .map_err(|error| format!("Google 账户信息响应无效：{error}"))?;
    let address = user["email"]
        .as_str()
        .ok_or_else(|| "Google 未返回邮箱地址".to_string())?
        .to_lowercase();
    let label = user["name"].as_str().unwrap_or(&address).to_string();
    let mut accounts = read_mail_accounts()?;
    let account = if let Some(existing) = accounts
        .iter_mut()
        .find(|account| account.provider == "gmail" && account.address == address && account.auth_type == "oauth")
    {
        existing.label = label;
        existing.connection_state = "connected".to_string();
        existing.clone()
    } else {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();
        let account = MailAccount {
            id: format!("gmail-{timestamp}"),
            provider: "gmail".to_string(),
            address,
            label,
            auth_type: "oauth".to_string(),
            connection_state: "connected".to_string(),
        };
        accounts.push(account.clone());
        account
    };
    if cancelled.load(Ordering::SeqCst) { return Err("已取消 Gmail 授权".into()); }
    write_gmail_token(
        &account.id,
        &GmailToken {
            access_token,
            refresh_token,
            expires_at: now_seconds()? + expires_in,
        },
    )?;
    write_mail_accounts(&accounts)?;
    Ok(account)
}

#[tauri::command]
async fn connect_gmail() -> Result<MailAccount, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut current = GMAIL_AUTH.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "授权状态不可用")?;
        if current.is_some() { return Err("已有授权正在进行，请先取消或等待结束".into()); }
        *current = Some(cancelled.clone());
    }
    let worker_cancelled = cancelled.clone();
    let result = tauri::async_runtime::spawn_blocking(move || connect_gmail_blocking(worker_cancelled)).await.map_err(|e| e.to_string());
    if let Ok(mut current) = GMAIL_AUTH.get_or_init(|| Mutex::new(None)).lock() {
        if current.as_ref().is_some_and(|value| Arc::ptr_eq(value, &cancelled)) { *current = None; }
    }
    result?
}

#[tauri::command]
fn cancel_gmail_auth() -> Result<(), String> {
    let current = GMAIL_AUTH.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "授权状态不可用")?;
    if let Some(cancelled) = current.as_ref() { cancelled.store(true, Ordering::SeqCst); }
    Ok(())
}

#[tauri::command]
async fn list_mail_messages(account_id: String) -> Result<Vec<MailMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || list_mail_messages_blocking(account_id)).await.map_err(|_| "读取邮件任务失败".to_string())?
}

fn list_mail_messages_blocking(account_id: String) -> Result<Vec<MailMessage>, String> {
    let accounts = read_mail_accounts()?;
    let account = accounts
        .iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "邮箱账户不存在".to_string())?;
    if account.provider != "gmail" || account.connection_state != "connected" {
        return Err("该邮箱尚未完成 Gmail 连接".to_string());
    }
    if account.auth_type == "app_password" { return imap_mail::list(account); }
    let listing = gmail_api_get(&account.id, "messages?labelIds=INBOX&maxResults=20")?;
    let mut messages = Vec::new();
    for id in listing["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str())
    {
        let message = gmail_api_get(
            &account.id,
            &format!("messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"),
        )?;
        messages.push(mail_message_from_gmail(&message, false));
    }
    Ok(messages)
}

#[tauri::command]
async fn get_mail_message(account_id: String, message_id: String) -> Result<MailMessage, String> {
    tauri::async_runtime::spawn_blocking(move || get_mail_message_blocking(account_id, message_id)).await.map_err(|_| "读取邮件任务失败".to_string())?
}

fn get_mail_message_blocking(account_id: String, message_id: String) -> Result<MailMessage, String> {
    if message_id.trim().is_empty()
        || !message_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("邮件标识无效".to_string());
    }
    let accounts = read_mail_accounts()?;
    let account = accounts
        .iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "邮箱账户不存在".to_string())?;
    if account.provider != "gmail" || account.connection_state != "connected" {
        return Err("该邮箱尚未完成 Gmail 连接".to_string());
    }
    if account.auth_type == "app_password" { return imap_mail::message(account, &message_id); }
    let message = gmail_api_get(&account.id, &format!("messages/{message_id}?format=full"))?;
    Ok(mail_message_from_gmail(&message, true))
}

#[tauri::command]
fn register_custom_service(
    name: String,
    target: String,
    kind: String,
) -> Result<CustomService, String> {
    let name = safe_note_name(&name)?;
    let target = target.trim().to_string();
    let kind = kind.trim().to_lowercase();
    valid_custom_service(&kind, &target)?;
    let mut services = read_custom_services()?;
    if services
        .iter()
        .any(|service| service.name == name || service.target == target)
    {
        return Err("该名称或目标地址已登记".to_string());
    }
    let id = format!("custom-{}", now_seconds()?);
    let service = CustomService {
        id,
        name,
        target,
        kind,
    };
    services.push(service.clone());
    write_custom_services(&services)?;
    Ok(service)
}

#[tauri::command]
fn remove_custom_service(id: String) -> Result<(), String> {
    let mut services = read_custom_services()?;
    let original = services.len();
    services.retain(|service| service.id != id);
    if services.len() == original {
        return Err("自定义服务不存在".to_string());
    }
    write_custom_services(&services)
}

fn read_services() -> Result<Vec<ServiceStatus>, String> {
    let config_path = if is_development() { app_data_dir().join("dsh-ssh.json") } else { home_dir().join(".dsh").join("dsh-ssh.json") };
    let mut services = match fs::read_to_string(&config_path) {
        Ok(source) => {
            let config: DshSshConfig = serde_json::from_str(&source)
                .map_err(|error| format!("DSH SSH 登记格式无效：{error}"))?;
            config.hosts.into_iter().map(probe_service).collect()
        }
        Err(_) => Vec::new(),
    };
    services.extend(
        read_custom_services()?
            .into_iter()
            .map(probe_custom_service),
    );
    Ok(services)
}

#[tauri::command]
async fn list_services() -> Result<Vec<ServiceStatus>, String> {
    tauri::async_runtime::spawn_blocking(read_services).await.map_err(|e| e.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let expected_identifier = if is_development() { "com.xu3ji.northstar-workbench.dev" } else { "com.xu3ji.northstar-workbench" };
            if app.config().identifier != expected_identifier {
                return Err(std::io::Error::other("应用标识与数据环境不一致，已拒绝启动以保护数据").into());
            }
            if is_development() { fs::create_dir_all(task_directory())?; }
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let area = monitor.work_area();
                    let scale = monitor.scale_factor();
                    let width = (area.size.width as f64 / scale * 0.88).min(1350.0);
                    let height = (area.size.height as f64 / scale * 0.88).min(900.0);
                    let _ = window.set_size(tauri::LogicalSize::new(width, height));
                    let _ = window.center();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_context,
            list_obsidian_tasks,
            create_obsidian_task,
            change_northstar_task,
            set_obsidian_task_completion,
            list_obsidian_notes,
            create_obsidian_note,
            create_obsidian_directory,
            list_services,
            list_mail_accounts,
            register_mail_account,
            get_sidebar_counts,
            get_gmail_setup,
            set_gmail_client_id,
            set_gmail_client_secret,
            connect_gmail,
            imap_mail::connect_gmail_imap,
            cancel_gmail_auth,
            list_mail_messages,
            get_mail_message,
            register_custom_service,
            remove_custom_service
        ])
        .run(tauri::generate_context!())
        .expect("error while running Northstar Workbench");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_credential_store_persists_across_separate_entries() {
        let name = format!("selftest-{}", random_url_safe(24));
        let service = "Northstar Workbench Credential Selftest";
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = self.0.delete_credential(); } }
        let entry = keyring::Entry::new(service, &name).unwrap();
        let _cleanup = Cleanup(keyring::Entry::new(service, &name).unwrap());
        entry.set_password("northstar-synthetic-test-value").unwrap();
        drop(entry);
        let reopened = keyring::Entry::new(service, &name).unwrap();
        assert_eq!(reopened.get_password().unwrap(), "northstar-synthetic-test-value");
    }

    #[test]
    fn token_requests_include_secret_only_when_configured() {
        let without = token_parameters_with_secret(vec![("grant_type", "refresh_token")], None);
        assert_eq!(without.len(), 1);
        let with = token_parameters_with_secret(vec![("grant_type", "authorization_code")], Some("test-only"));
        assert!(with.contains(&("client_secret", "test-only")));
        let refresh = token_parameters_with_secret(vec![("grant_type", "refresh_token")], Some("test-only"));
        assert!(refresh.contains(&("client_secret", "test-only")));
    }

    #[test]
    fn token_request_posts_secret_to_local_mock_only() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let length = headers.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                    }).unwrap();
                    if bytes.len() >= header_end + 4 + length { break; }
                }
            }
            let body = String::from_utf8(bytes).unwrap();
            assert!(body.contains("client_secret=test-only"));
            let response = b"{\"access_token\":\"test-token\"}";
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
            stream.write_all(response).unwrap();
        });
        let params = token_parameters_with_secret(vec![("grant_type", "authorization_code")], Some("test-only"));
        let result = gmail_token_request_to(&format!("http://{address}/token"), &params).unwrap();
        assert_eq!(result["access_token"], "test-token");
        server.join().unwrap();
    }

    #[test]
    fn gmail_token_errors_explain_known_codes_without_echoing_sensitive_input() {
        let known = gmail_token_error(400, Some("invalid_grant"), None);
        assert!(known.contains("invalid_grant"));
        assert!(known.contains("重新开始授权"));
        let unknown = gmail_token_error(400, Some("secret-token-from-server"), Some("secret-token-from-server"));
        assert!(unknown.contains("unknown_error"));
        assert!(!unknown.contains("secret-token-from-server"));
        let missing = gmail_token_error(400, Some("invalid_request"), Some("client_secret is missing: sensitive-value"));
        assert!(missing.contains("需要 client_secret"));
        assert!(!missing.contains("sensitive-value"));
    }

    #[test]
    fn gmail_wait_can_be_cancelled_without_a_browser_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let worker = std::thread::spawn(move || gmail_callback(listener, "test-state", &flag));
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap().unwrap_err(), "已取消 Gmail 授权");
    }

    #[test]
    fn gmail_callback_does_not_claim_connection_is_complete() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || gmail_callback(listener, "local-test-state", &AtomicBool::new(false)));
        let mut browser = TcpStream::connect(address).unwrap();
        browser.write_all(b"GET /?state=local-test-state&code=local-test-code HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut response = String::new();
        browser.read_to_string(&mut response).unwrap();
        assert!(response.contains("邮箱连接尚未完成"));
        assert_eq!(worker.join().unwrap().unwrap(), "local-test-code");
    }

    #[cfg(any(debug_assertions, feature = "dev-isolation"))]
    #[test]
    fn development_storage_is_separate_from_production() {
        assert!(is_development());
        assert!(app_data_dir().ends_with("Northstar Workbench Dev"));
        assert_eq!(vault_path(), app_data_dir().join("TestVault"));
        assert_ne!(vault_path(), home_dir().join("ObsidianVault"));
        assert!(mail_registry_path().starts_with(app_data_dir()));
        assert!(mail_settings_path().starts_with(app_data_dir()));
        assert!(custom_services_path().starts_with(app_data_dir()));
        assert_eq!(gmail_credential_service(), "Northstar Workbench Dev Gmail");
        assert_eq!(gmail_oauth_credential_service(), "Northstar Workbench Dev Google OAuth");
    }

    #[test]
    fn reads_northstar_details_without_exposing_metadata() {
        let details = "第一行\n第二行";
        let line = format!("- [ ] 测试 — 第一行 第二行 <!-- northstar-detail:{} --> <!-- northstar-remind:2027-01-03T09:30 -->", URL_SAFE_NO_PAD.encode(details));
        let task = task_from_line("待办事项/Northstar.md", 0, &line).unwrap();
        assert_eq!(task.title, "测试");
        assert_eq!(task.details, details);
        assert_eq!(task.raw, line);
        assert_eq!(task.reminder_at.as_deref(), Some("2027-01-03T09:30"));
    }

    #[test]
    fn parses_markdown_tasks_and_preserves_titles() {
        let task = task_from_line("待办事项/test.md", 2, "  - [x] 下周处理邮箱").unwrap();
        assert!(task.completed);
        assert_eq!(task.title, "下周处理邮箱");
        assert_eq!(task.reminder_at, None);
        assert_eq!(task.line, 2);
    }

    #[test]
    fn reads_only_precise_reminder_metadata() {
        let task = task_from_line(
            "待办事项/test.md",
            2,
            "- [ ] 整理收件箱 <!-- northstar-remind:2026-11-07T20:30 -->",
        )
        .unwrap();
        assert_eq!(task.title, "整理收件箱");
        assert_eq!(task.reminder_at, Some("2026-11-07T20:30".to_string()));
        assert!(safe_reminder_at(Some("下周".to_string())).is_err());
    }

    #[test]
    fn rejects_paths_outside_the_vault() {
        assert!(safe_relative("../secret.md").is_err());
        assert!(safe_relative("C:\\outside.md").is_err());
        assert!(safe_relative("待办事项/Northstar.md").is_ok());
    }

    #[test]
    fn parses_ssh_probe_values() {
        let output = "__host=seoul\n__docker=active\n__new-api=running\n";
        assert_eq!(parse_probe(output, "host"), Some("seoul".to_string()));
        assert_eq!(parse_probe(output, "new-api"), Some("running".to_string()));
        assert_eq!(
            expected_checks("seoul"),
            vec!["openclaw-gateway", "docker", "new-api"]
        );
    }

    #[test]
    fn maps_mail_providers_to_safe_auth_modes() {
        assert_eq!(mail_auth_type("gmail"), Some("oauth"));
        assert_eq!(mail_auth_type("outlook"), Some("oauth"));
        assert_eq!(mail_auth_type("qq"), Some("app_password"));
        assert_eq!(mail_auth_type("unknown"), None);
    }

    #[test]
    fn accepts_only_desktop_google_client_ids() {
        assert!(valid_google_client_id(
            "123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com"
        ));
        assert!(!valid_google_client_id("not-a-client-id"));
        assert!(!valid_google_client_id(
            "123456789012-abc.apps.googleusercontent.com?bad"
        ));
    }

    #[test]
    fn reads_gmail_metadata_and_plain_text_body() {
        let value = serde_json::json!({
            "id": "abc-123",
            "threadId": "thread-1",
            "snippet": "A short preview",
            "labelIds": ["INBOX", "UNREAD"],
            "payload": {
                "mimeType": "text/plain",
                "headers": [
                    {"name": "From", "value": "Northstar <hello@example.com>"},
                    {"name": "Subject", "value": "Hello"},
                    {"name": "Date", "value": "Fri, 7 Nov 2026 12:00:00 +0800"}
                ],
                "body": {"data": "SGVsbG8sIE5vcnRoc3RhciE"}
            }
        });
        let message = mail_message_from_gmail(&value, true);
        assert_eq!(message.subject, "Hello");
        assert_eq!(message.from, "Northstar <hello@example.com>");
        assert_eq!(message.body, Some("Hello, Northstar!".to_string()));
        assert_eq!(message.labels, vec!["INBOX", "UNREAD"]);
    }

    #[test]
    fn validates_custom_service_targets() {
        assert!(valid_custom_service("http", "https://status.example.com/health").is_ok());
        assert!(valid_custom_service("http", "ftp://status.example.com").is_err());
        assert!(valid_custom_service("tcp", "127.0.0.1").is_err());
        assert!(valid_custom_service("unknown", "anything").is_err());
    }

    #[test]
    fn persists_mail_account_metadata_without_credentials() {
        let directory = std::env::temp_dir().join(format!(
            "northstar-workbench-mail-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("mail-accounts.json");
        let account = new_mail_account(
            "qq".to_string(),
            "me@qq.com".to_string(),
            "私人邮箱".to_string(),
            &[],
            1,
        )
        .unwrap();
        write_mail_accounts_at(&path, &[account.clone()]).unwrap();
        let restored = read_mail_accounts_at(&path).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].address, "me@qq.com");
        assert_eq!(restored[0].auth_type, "app_password");
        assert!(new_mail_account(
            "qq".to_string(),
            "me@qq.com".to_string(),
            "".to_string(),
            &restored,
            2
        )
        .is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
