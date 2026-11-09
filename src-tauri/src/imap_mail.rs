use super::{is_development, read_mail_accounts, write_mail_accounts, MailAccount, MailMessage, MailSyncResult};
use mailparse::MailHeaderMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Session = imap::Session<native_tls::TlsStream<TcpStream>>;
const HOST: &str = "imap.gmail.com";

fn entry(id: &str) -> Result<keyring::Entry, String> {
    #[cfg(not(windows))]
    { let _ = id; return Err("当前系统尚未配置安全凭据存储".into()); }
    #[cfg(windows)]
    keyring::Entry::new(if is_development() { "Northstar Workbench Dev IMAP" } else { "Northstar Workbench IMAP" }, id)
        .map_err(|_| "无法打开 Windows 凭据管理器".into())
}

fn login(address: &str, password: &str) -> Result<Session, String> {
    let endpoints = (HOST, 993).to_socket_addrs().map_err(|_| "无法解析 Gmail 服务器，请检查网络".to_string())?;
    let stream = endpoints.take(4).find_map(|endpoint| TcpStream::connect_timeout(&endpoint, Duration::from_secs(5)).ok())
        .ok_or_else(|| "无法连接 Gmail IMAP，请检查网络".to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(20))).map_err(|_| "无法设置连接超时".to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(20))).map_err(|_| "无法设置连接超时".to_string())?;
    let tls = native_tls::TlsConnector::new().map_err(|_| "无法初始化安全连接".to_string())?;
    let stream = tls.connect(HOST, stream).map_err(|_| "Gmail 安全连接失败，请检查网络".to_string())?;
    let mut client = imap::Client::new(stream);
    client.read_greeting().map_err(|_| "Gmail 服务器未响应".to_string())?;
    client.login(address, password).map_err(|_| "Gmail 登录失败：请检查邮箱地址、应用专用密码及账号的两步验证设置".to_string())
}

fn open(account: &MailAccount, category: &str) -> Result<(Session, u32), String> {
    let password = entry(&account.id)?.get_password().map_err(|_| "未找到应用专用密码，请重新连接邮箱".to_string())?;
    let mut session = login(&account.address, &password)?;
    let folder = if category == "inbox" { "INBOX".to_string() } else {
        let flag = if category == "spam" { "\\Junk" } else { "\\All" };
        let folders = session.list(None, Some("*")).map_err(|_| "无法读取 Gmail 文件夹".to_string())?;
        folders.iter().find(|folder| folder.attributes().iter().any(|attr| matches!(attr, imap::types::NameAttribute::Custom(value) if value.eq_ignore_ascii_case(flag))))
            .map(|folder| folder.name().to_string()).ok_or_else(|| "未找到 Gmail 对应文件夹，请检查邮箱的 IMAP 设置".to_string())?
    };
    let mailbox = session.examine(&folder).map_err(|_| "无法读取 Gmail 文件夹".to_string())?;
    let validity = mailbox.uid_validity.ok_or_else(|| "邮箱不支持稳定的邮件标识".to_string())?;
    Ok((session, validity))
}

#[tauri::command]
pub(super) async fn connect_gmail_imap(address: String, password: String) -> Result<MailAccount, String> {
    tauri::async_runtime::spawn_blocking(move || connect(&address, &password)).await.map_err(|_| "连接邮箱任务失败".to_string())?
}

fn connect(address: &str, password: &str) -> Result<MailAccount, String> {
    let address = address.trim().to_lowercase();
    let password: String = password.chars().filter(|c| !c.is_whitespace()).collect();
    if !(address.ends_with("@gmail.com") || address.ends_with("@googlemail.com")) || password.is_empty() {
        return Err("请填写个人 Gmail 地址和应用专用密码".into());
    }
    let mut session = login(&address, &password)?;
    session.examine("INBOX").map_err(|_| "已登录，但无法读取 Gmail 收件箱".to_string())?;
    let _ = session.logout();
    let mut accounts = read_mail_accounts()?;
    let existing = accounts.iter().position(|a| a.provider == "gmail" && a.address == address && a.auth_type == "app_password");
    let id = match existing { Some(i) => accounts[i].id.clone(), None => format!("gmail-imap-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "系统时间错误")?.as_millis()) };
    let account = MailAccount { id, provider: "gmail".into(), label: address.clone(), address, auth_type: "app_password".into(), connection_state: "connected".into() };
    entry(&account.id)?.set_password(&password).map_err(|_| "无法将应用专用密码保存至 Windows 凭据管理器".to_string())?;
    if let Some(i) = existing { accounts[i] = account.clone(); } else { accounts.push(account.clone()); }
    write_mail_accounts(&accounts)?;
    Ok(account)
}

fn parse_message(id: String, bytes: &[u8], full: bool) -> Result<MailMessage, String> {
    let parsed = mailparse::parse_mail(bytes).map_err(|_| "邮件格式无法解析".to_string())?;
    fn body(part: &mailparse::ParsedMail<'_>, wanted: &str) -> Option<String> {
        let disposition = part.get_content_disposition();
        if disposition.disposition == mailparse::DispositionType::Attachment || disposition.params.contains_key("filename") || part.ctype.mimetype.eq_ignore_ascii_case("message/rfc822") { return None; }
        if part.ctype.mimetype.eq_ignore_ascii_case(wanted) && part.subparts.is_empty() {
            return part.get_body().ok().filter(|body| !body.trim().is_empty());
        }
        part.subparts.iter().find_map(|child| body(child, wanted))
    }
    Ok(MailMessage { thread_id: id.clone(), id, from: parsed.headers.get_first_value("From").unwrap_or_default(), subject: parsed.headers.get_first_value("Subject").unwrap_or_default(), date: parsed.headers.get_first_value("Date").unwrap_or_default(), snippet: String::new(), labels: vec![], body: if full { body(&parsed, "text/plain") } else { None }, html_body: if full { body(&parsed, "text/html").and_then(|html| super::sanitize_mail_html(&html)) } else { None } })
}

pub(super) fn list(account: &MailAccount, category: &str) -> Result<Vec<MailMessage>, String> {
    let (mut session, validity) = open(account, category)?;
    let query = match category { "unread" => "UNSEEN", "read" => "SEEN", _ => "ALL" };
    let mut uids: Vec<u32> = session.uid_search(query).map_err(|_| "无法查询 Gmail 邮件".to_string())?.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(20);
    let mut result = Vec::new();
    if !uids.is_empty() {
        let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched = session.uid_fetch(set, "(UID FLAGS BODY.PEEK[HEADER]<0.65536>)").map_err(|_| "无法读取邮件列表".to_string())?;
        for uid in uids {
            if let Some(item) = fetched.iter().find(|f| f.uid == Some(uid)) {
                if let Some(header) = item.header() { let mut message = parse_message(format!("{validity}-{uid}"), header, false)?; if !item.flags().iter().any(|f| matches!(f, imap::types::Flag::Seen)) { message.labels.push("UNREAD".into()); } result.push(message); }
            }
        }
    }
    let _ = session.logout();
    Ok(result)
}

pub(super) fn sync(account: &MailAccount, category: &str, known_ids: &[String]) -> Result<MailSyncResult, String> {
    let (mut session, validity) = open(account, category)?;
    let result = sync_folder(&mut session, validity, category, known_ids)?;
    let _ = session.logout();
    Ok(result)
}

fn sync_folder<T: std::io::Read + std::io::Write>(session: &mut imap::Session<T>, validity: u32, category: &str, known_ids: &[String]) -> Result<MailSyncResult, String> {
    let query = match category { "unread" => "UNSEEN", "read" => "SEEN", _ => "ALL" };
    let mut uids: Vec<u32> = session.uid_search(query).map_err(|_| "无法查询 Gmail 邮件".to_string())?.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a)); uids.truncate(20);
    let mut order = Vec::new(); let mut unread = Vec::new(); let mut missing = Vec::new();
    if !uids.is_empty() {
        let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let flags = session.uid_fetch(set, "(UID FLAGS)").map_err(|_| "无法读取邮件状态".to_string())?;
        for uid in uids {
            if let Some(item) = flags.iter().find(|item| item.uid == Some(uid)) {
                let id = format!("{validity}-{uid}");
                if !item.flags().iter().any(|flag| matches!(flag, imap::types::Flag::Seen)) { unread.push(id.clone()); }
                if !known_ids.contains(&id) { missing.push(uid); }
                order.push(id);
            }
        }
    }
    let mut new_messages = Vec::new();
    if !missing.is_empty() {
        let set = missing.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let headers = session.uid_fetch(set, "(UID BODY.PEEK[HEADER]<0.65536>)").map_err(|_| "无法读取新增邮件".to_string())?;
        for uid in missing {
            if let Some(header) = headers.iter().find(|item| item.uid == Some(uid)).and_then(|item| item.header()) {
                let id = format!("{validity}-{uid}");
                let mut message = parse_message(id.clone(), header, false)?;
                if unread.contains(&id) { message.labels.push("UNREAD".into()); }
                new_messages.push(message);
            }
        }
    }
    Ok(MailSyncResult { order, unread, new_messages })
}

pub(super) fn message(account: &MailAccount, id: &str, category: &str) -> Result<MailMessage, String> {
    let (validity, uid) = id.split_once('-').ok_or_else(|| "邮件标识无效".to_string())?;
    let validity: u32 = validity.parse().map_err(|_| "邮件标识无效".to_string())?;
    let uid: u32 = uid.parse().map_err(|_| "邮件标识无效".to_string())?;
    if uid == 0 { return Err("邮件标识无效".into()); }
    let (mut session, actual_validity) = open(account, category)?;
    if validity != actual_validity { return Err("收件箱已发生变化，请刷新列表".into()); }
    let result = {
        let fetched = session.uid_fetch(uid.to_string(), "(UID RFC822.SIZE BODY.PEEK[]<0.5242880>)").map_err(|_| "无法读取邮件正文".to_string())?;
        let item = fetched.iter().find(|f| f.uid == Some(uid)).ok_or_else(|| "邮件不存在，请刷新列表".to_string())?;
        if item.size.unwrap_or(0) > 5_242_880 { return Err("邮件超过 5 MB，暂无法读取正文".into()); }
        parse_message(id.to_string(), item.body().ok_or_else(|| "邮件正文不可用".to_string())?, true)?
    };
    let _ = session.logout();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read, Write};

    struct MockStream(Cursor<Vec<u8>>);
    impl Read for MockStream { fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> { self.0.read(buf) } }
    impl Write for MockStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { Ok(buf.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    struct RecordingStream { input: Cursor<Vec<u8>>, output: std::sync::Arc<std::sync::Mutex<Vec<u8>>> }
    impl Read for RecordingStream { fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> { self.input.read(buf) } }
    impl Write for RecordingStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> { self.output.lock().unwrap().extend_from_slice(buf); Ok(buf.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }

    #[test]
    fn sync_fetches_headers_only_for_new_messages_and_refreshes_flags() {
        let header = "From: new@example.com\r\nSubject: New mail\r\n\r\n";
        let responses = format!("* OK hello\r\na1 OK logged in\r\n* SEARCH 10 11\r\na2 OK SEARCH completed\r\n* 1 FETCH (UID 10 FLAGS (\\Seen))\r\n* 2 FETCH (UID 11 FLAGS ())\r\na3 OK FETCH completed\r\n* 2 FETCH (UID 11 BODY[HEADER]<0> {{{}}}\r\n{})\r\na4 OK FETCH completed\r\n", header.len(), header);
        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut client = imap::Client::new(RecordingStream { input: Cursor::new(responses.into_bytes()), output: output.clone() });
        client.read_greeting().unwrap();
        let mut session = client.login("synthetic", "synthetic").ok().unwrap();
        let result = sync_folder(&mut session, 42, "all", &["42-10".into()]).unwrap();
        assert_eq!(result.order, ["42-11", "42-10"]);
        assert_eq!(result.unread, ["42-11"]);
        assert_eq!(result.new_messages.len(), 1);
        assert_eq!(result.new_messages[0].subject, "New mail");
        let commands = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        assert!(commands.contains("UID FETCH 11 (UID BODY.PEEK[HEADER]"));
        assert!(!commands.contains("UID FETCH 10 (UID BODY.PEEK[HEADER]"));
    }
    #[test]
    fn sync_drops_removed_items_and_updates_seen_without_downloading_headers() {
        let responses = b"* OK hello\r\na1 OK logged in\r\n* SEARCH 11\r\na2 OK SEARCH completed\r\n* 1 FETCH (UID 11 FLAGS (\\Seen))\r\na3 OK FETCH completed\r\n";
        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut client = imap::Client::new(RecordingStream { input: Cursor::new(responses.to_vec()), output: output.clone() });
        client.read_greeting().unwrap();
        let mut session = client.login("synthetic", "synthetic").ok().unwrap();
        let result = sync_folder(&mut session, 42, "all", &["42-10".into(), "42-11".into()]).unwrap();
        assert_eq!(result.order, ["42-11"]);
        assert!(result.unread.is_empty() && result.new_messages.is_empty());
        assert!(!String::from_utf8(output.lock().unwrap().clone()).unwrap().contains("BODY.PEEK"));
    }

    #[test]
    fn recognizes_gmail_special_use_folders() {
        let response = b"* OK hello\r\na1 OK logged in\r\n* LIST (\\HasNoChildren \\All) \"/\" \"[Gmail]/All Mail\"\r\n* LIST (\\HasNoChildren \\Junk) \"/\" \"[Gmail]/Spam\"\r\na2 OK LIST completed\r\n";
        let mut client = imap::Client::new(MockStream(Cursor::new(response.to_vec())));
        client.read_greeting().unwrap();
        let mut session = client.login("synthetic", "synthetic").ok().unwrap();
        let folders = session.list(None, Some("*")).unwrap();
        for (name, flag) in [("[Gmail]/All Mail", "\\All"), ("[Gmail]/Spam", "\\Junk")] {
            assert!(folders.iter().any(|folder| folder.name() == name && folder.attributes().iter().any(|attr| matches!(attr, imap::types::NameAttribute::Custom(value) if value.eq_ignore_ascii_case(flag)))));
        }
    }
    #[test]
    fn parses_encoded_headers_and_plain_body() {
        let mail = b"From: sender@example.com\r\nSubject: =?UTF-8?B?5rWL6K+V?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello";
        let message = parse_message("1-2".into(), mail, true).unwrap();
        assert_eq!(message.subject, "测试");
        assert_eq!(message.body.as_deref(), Some("hello"));
    }
}

#[cfg(test)]
mod html_regression_tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    #[test]
    fn mime_html_only_and_attachments_are_handled() {
        let encoded = STANDARD.encode("<h2>旅行优惠</h2><p>你好</p><img src='https://tracker.invalid/a'>");
        let raw = format!("MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=note.txt\r\n\r\nNOT BODY\r\n--x\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n--x--\r\n");
        let message = parse_message("1-1".into(), raw.as_bytes(), true).unwrap();
        assert!(message.body.is_none());
        let html = message.html_body.unwrap();
        assert!(html.contains("旅行优惠") && html.contains("你好"));
        assert!(!html.contains("tracker.invalid"));
        assert!(parse_message("1-1".into(), raw.as_bytes(), false).unwrap().html_body.is_none());
    }
}
