import { useEffect, useRef, useState } from "react";
import { desktopApi, type DesktopContext, type GmailSetup, type MailAccount, type MailCategory, type MailMessage } from "./desktop";

type Provider = MailAccount["provider"];
const defaults: Provider[] = ["gmail", "outlook", "qq", "imap"];
const names: Record<Provider, string> = { gmail: "Gmail", outlook: "Outlook", qq: "QQ 邮箱", imap: "其他邮箱" };
const categories: { id: MailCategory; label: string }[] = [
  { id: "all", label: "全部邮件" }, { id: "inbox", label: "收件箱" },
  { id: "unread", label: "未读" }, { id: "read", label: "已读" }, { id: "spam", label: "垃圾邮件" },
];
const orderKey = "northstar.mail-provider-order.v1";

function readOrder(): Provider[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(orderKey) || "null");
    if (Array.isArray(value)) {
      const valid = value.filter((item): item is Provider => defaults.includes(item as Provider));
      return [...new Set([...valid, ...defaults])];
    }
  } catch { /* Restore defaults when preferences are unavailable. */ }
  return defaults;
}
function filterMail(items: MailMessage[], category: MailCategory) {
  if (category === "unread") return items.filter(item => item.labels.includes("UNREAD"));
  if (category === "read") return items.filter(item => !item.labels.includes("UNREAD"));
  return items;
}
function sourceCategory(category: MailCategory): MailCategory { return category === "read" || category === "unread" ? "all" : category; }
function reasonText(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function mailCacheKey(environment: string, account: string, category: MailCategory) { return `northstar.mail-cache.v1:${environment}:${account}:${category}`; }
function readMailCache(key: string): MailMessage[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    if (!Array.isArray(value) || value.length > 20) return null;
    return value.filter((item): item is MailMessage => item && typeof item.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(item.id) && typeof item.threadId === "string" && typeof item.from === "string" && typeof item.subject === "string" && typeof item.date === "string" && typeof item.snippet === "string" && Array.isArray(item.labels) && item.labels.every((label: unknown) => typeof label === "string"));
  } catch { return null; }
}
function writeMailCache(key: string, messages: MailMessage[]) {
  try { localStorage.setItem(key, JSON.stringify(messages.slice(0, 20).map(({body: _body, htmlBody: _htmlBody, ...metadata}) => metadata))); } catch { /* continue without persistent cache */ }
}
async function syncMessages(accountId: string, category: MailCategory, cached: MailMessage[]): Promise<MailMessage[]> {
  try {
    const result = await desktopApi.syncMailMessages(accountId, category, cached.map(item => item.id));
    const all = new Map([...cached, ...result.newMessages].map(item => [item.id, item]));
    const unread = new Set(result.unread);
    return result.order.flatMap(id => { const item = all.get(id); if (!item) return []; return [{ ...item, labels: [...item.labels.filter(label => label !== "UNREAD"), ...(unread.has(id) ? ["UNREAD"] : [])] }]; });
  } catch (reason) {
    if (/unknown command|not found|not recognized/i.test(reasonText(reason)) && /sync_mail_messages/i.test(reasonText(reason))) return desktopApi.listMailMessages(accountId, category);
    throw reason;
  }
}

export default function InboxPage({ desktop }: { desktop: DesktopContext | null }) {
  const [order, setOrder] = useState<Provider[]>(readOrder);
  const [provider, setProvider] = useState<Provider>("gmail");
  const [category, setCategory] = useState<MailCategory>("all");
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [setup, setSetup] = useState<GmailSetup | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [method, setMethod] = useState<"app_password" | "oauth">("app_password");
  const [address, setAddress] = useState(""); const [password, setPassword] = useState("");
  const [clientId, setClientId] = useState(""); const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false); const [cancelling, setCancelling] = useState(false);
  const [messages, setMessages] = useState<MailMessage[]>([]); const [message, setMessage] = useState<MailMessage | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [hasCache, setHasCache] = useState(false);
  const [notice, setNotice] = useState("");
  const [compact, setCompact] = useState(false);
  const synced = useRef(new Set<string>());
  const generation = useRef(0); const dragged = useRef<Provider | null>(null);
  const connected = accounts.filter(item => item.provider === provider && item.connectionState === "connected");

  useEffect(() => { try { localStorage.setItem(orderKey, JSON.stringify(order)); } catch { /* Still usable for this session. */ } }, [order]);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void Promise.all([desktopApi.listMailAccounts(), desktopApi.getGmailSetup()]).then(([next, gmail]) => {
      if (!active) return; setAccounts(next); setSetup(gmail);
    }).catch(reason => { if (active) setError(reasonText(reason)); });
    return () => { active = false; void desktopApi.cancelGmailAuth().catch(() => undefined); };
  }, [desktop]);
  useEffect(() => {
    const available = accounts.filter(item => item.provider === provider && item.connectionState === "connected");
    setAccountId(current => available.some(item => item.id === current) ? current : available[0]?.id || "");
  }, [provider, accounts]);
  useEffect(() => {
    if (!accountId || !desktop) { setMessages([]); setHasCache(false); setLoading(false); return; }
    const request = ++generation.current;
    const source = sourceCategory(category);
    const key = mailCacheKey(desktop.environment, accountId, source);
    const saved = readMailCache(key); const cached = saved ?? [];
    setError(""); setHasCache(saved !== null); setMessages(filterMail(cached, category)); setMessage(null);
    if (synced.current.has(key) && saved !== null) { setLoading(false); return; }
    setLoading(true);
    void syncMessages(accountId, source, cached).then(items => { if (request === generation.current) { synced.current.add(key); setMessages(filterMail(items, category)); setHasCache(true); writeMailCache(key, items); } })
      .catch(reason => { if (request === generation.current) setError(`${saved !== null ? "同步失败，正在显示本机缓存：" : "同步失败："}${reasonText(reason)}`); })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [accountId, category, desktop]);

  const reorder = (source: Provider, target: Provider) => {
    if (source === target) return;
    setOrder(current => { const targetIndex = current.indexOf(target); const next = current.filter(item => item !== source); next.splice(targetIndex, 0, source); return next; });
    setNotice(`${names[source]} 已移动到 ${names[target]} 附近`);
  };
  const refresh = async () => {
    if (!accountId) return;
    const request = ++generation.current; setLoading(true); setError(""); setMessage(null);
    const source = sourceCategory(category);
    const key = mailCacheKey(desktop?.environment || "production", accountId, source);
    const saved = readMailCache(key); const cached = saved ?? [];
    try { const items = await syncMessages(accountId, source, cached); if (request === generation.current) { synced.current.add(key); setMessages(filterMail(items, category)); setHasCache(true); writeMailCache(key, items); } }
    catch (reason) { if (request === generation.current) setError(`${saved !== null ? "同步失败，正在显示本机缓存：" : "同步失败："}${reasonText(reason)}`); }
    finally { if (request === generation.current) setLoading(false); }
  };
  const openMessage = async (item: MailMessage) => {
    const request = ++generation.current; setLoading(true); setError("");
    try { const result = await desktopApi.getMailMessage(accountId, item.id, category); if (request === generation.current) setMessage(result); }
    catch (reason) { if (request === generation.current) setError(reasonText(reason)); }
    finally { if (request === generation.current) setLoading(false); }
  };
  const connect = async () => {
    setBusy(true); setError("");
    try {
      const account = method === "app_password" ? await desktopApi.connectGmailImap(address, password) : await desktopApi.connectGmail();
      setAccounts(current => [...current.filter(item => item.id !== account.id), account]);
      setAccountId(account.id); setAddress(""); setShowSetup(false);
      if (account.id === accountId) void refresh();
    } catch (reason) { setError(reasonText(reason)); }
    finally { setPassword(""); setBusy(false); setCancelling(false); }
  };
  const saveId = async () => { setBusy(true); setError(""); try { setSetup(await desktopApi.setGmailClientId(clientId)); setClientId(""); } catch (reason) { setError(reasonText(reason)); } finally { setBusy(false); } };
  const saveSecret = async () => { setBusy(true); setError(""); try { setSetup(await desktopApi.setGmailClientSecret(clientSecret)); setClientSecret(""); } catch (reason) { setError(reasonText(reason)); } finally { setBusy(false); } };

  return <section className="module inbox inbox-redesign">
    <div className={`inbox-fixed${compact ? " compact" : ""}`}>
    <div className="inbox-header"><h1>我的收件箱</h1></div>
    <div className="mail-provider-tabs" role="tablist" aria-label="邮箱类型，按住 Alt 加左右方向键可调整顺序">
      {order.map((item, index) => <button key={item} role="tab" aria-selected={provider === item} className={provider === item ? "active" : ""} draggable
        onDragStart={event => { dragged.current = item; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item); }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
        onDrop={event => { event.preventDefault(); if (dragged.current) reorder(dragged.current, item); dragged.current = null; }} onDragEnd={() => { dragged.current = null; }}
        onKeyDown={event => { if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const target = index + (event.key === "ArrowLeft" ? -1 : 1); if (target < 0 || target >= order.length) return; reorder(item, order[target]); }}
        onClick={() => { if (item !== provider) { generation.current++; setAccountId(""); setMessages([]); setMessage(null); setError(""); setShowSetup(false); setProvider(item); setCategory("all"); } }}><span className={`mail-provider-icon ${item}`}>{item === "gmail" ? "M" : item === "outlook" ? "O" : item === "qq" ? "Q" : "✉"}</span>{names[item]}<span className="drag-hint" aria-hidden="true">⠿</span></button>)}
    </div><span className="sr-only" aria-live="polite">{notice}</span>
    <div className="mail-category-bar" aria-label="邮件分类">{categories.map(item => <button key={item.id} className={category === item.id ? "active" : ""} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
    </div>
    <div className="inbox-content" onScroll={event => setCompact(event.currentTarget.scrollTop > 32)}>
    {!desktop ? <div className="mail-placeholder"><b>请在 Windows 桌面版连接邮箱</b><p>桌面版可安全读取本机邮箱凭据。</p></div> : provider !== "gmail" ? <div className="mail-placeholder"><div className="mail-empty-icon">✉</div><b>{names[provider]}暂未接入</b><p>这个邮箱的授权和同步还在建设中。</p></div> : <>
      {connected.length > 0 && <div className="mail-toolbar"><div className="mail-account-picker"><span className="status"></span>{connected.length === 1 ? <b>{connected[0].address}</b> : <select aria-label="选择 Gmail 账户" value={accountId} onChange={event => setAccountId(event.target.value)}>{connected.map(item => <option key={item.id} value={item.id}>{item.address}</option>)}</select>}</div><div><button onClick={() => setShowSetup(value => !value)}>{showSetup ? "完成" : "＋ 添加账号"}</button><button disabled={loading || !accountId} onClick={() => void refresh()}>{loading ? "同步中…" : "刷新"}</button></div></div>}
      {(showSetup || connected.length === 0) && <section className="mail-setup"><h2>{connected.length ? "添加 Gmail" : "连接 Gmail"}</h2><div className="gmail-methods"><button className={method === "app_password" ? "selected" : ""} onClick={() => setMethod("app_password")}>应用专用密码</button><button className={method === "oauth" ? "selected" : ""} onClick={() => setMethod("oauth")}>Google 授权（高级）</button></div>
        {method === "app_password" ? <div className="gmail-connect"><p>输入 Gmail 地址和应用专用密码，连接后自动同步邮件。</p><div className="mail-fields"><input type="email" value={address} onChange={event => setAddress(event.target.value)} placeholder="Gmail 地址" aria-label="Gmail 地址" /><input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="应用专用密码" aria-label="应用专用密码" /><button className="primary" disabled={busy || !address.trim() || !password.trim()} onClick={() => void connect()}>{busy ? "正在连接…" : "连接 Gmail"}</button></div><p>首次使用需要开启 Google 两步验证并生成密码。 <button type="button" className="gmail-help-link" onClick={() => void desktopApi.openGmailAppPasswords().catch(reason => setError(reasonText(reason)))}>打开 Google 设置 ↗</button></p></div> : <div className="gmail-connect">{!setup?.configured ? <><p>填写 Google 桌面客户端 ID。</p><div className="mail-fields"><input className="gmail-client-id" value={clientId} onChange={event => setClientId(event.target.value)} placeholder="123…apps.googleusercontent.com" /><button className="primary" disabled={busy || !clientId.trim()} onClick={() => void saveId()}>保存 Client ID</button></div></> : <><p>已配置 Client ID（{setup.clientIdHint}），授权令牌保存在本机。</p><div className="gmail-secret"><input type="password" autoComplete="off" value={clientSecret} onChange={event => setClientSecret(event.target.value)} aria-label="Google 客户端密钥" placeholder={setup.clientSecretConfigured ? "替换客户端密钥（可选）" : "Google 客户端密钥"} /><button disabled={busy || !clientSecret.trim()} onClick={() => void saveSecret()}>保存密钥</button></div><div className="gmail-actions"><button className="primary" disabled={busy} onClick={() => void connect()}>{busy ? "等待浏览器授权…" : "连接 Gmail"}</button>{busy && <button disabled={cancelling} onClick={() => { setCancelling(true); void desktopApi.cancelGmailAuth().catch(reason => { setError(reasonText(reason)); setCancelling(false); }); }}>取消授权</button>}</div></>}</div>}
        <p className="setup-note">凭据保存在 Windows 凭据管理器；邮件以只读方式访问。</p></section>}
      {error && <p role="alert" className="inline-error">{error}</p>}
      {connected.length > 0 && <section className="mail-reader">{message ? <article className="message-detail"><button className="back" onClick={() => setMessage(null)}>‹ 返回列表</button><h2>{message.subject || "（无主题）"}</h2><p className="message-meta">{message.from} · {message.date}</p>{message.htmlBody ? <div className="message-html" dangerouslySetInnerHTML={{ __html: message.htmlBody }} /> : <pre>{message.body || message.snippet || "此邮件没有可显示的正文。"}</pre>}</article> : <><div className="mail-list-heading"><b>{categories.find(item => item.id === category)?.label}</b><span>{category === "read" || category === "unread" ? "筛选最近 20 封全部邮件 · 只读" : "显示最近 20 封 · 只读"}</span></div>{loading && !hasCache ? <div className="mail-placeholder"><p>正在同步邮件…</p></div> : messages.length === 0 ? <div className="mail-placeholder"><div className="mail-empty-icon">✉</div><b>这里暂时没有邮件</b><p>试试其他分类，或刷新列表。</p></div> : <div className="message-list">{messages.map(item => <button key={item.id} onClick={() => void openMessage(item)}><span className={item.labels.includes("UNREAD") ? "mail-unread-dot" : "mail-read-dot"} aria-label={item.labels.includes("UNREAD") ? "未读" : "已读"}></span><div><b>{item.subject || "（无主题）"}</b><span>{item.from}</span>{item.snippet && <p>{item.snippet}</p>}</div><small>{item.date}</small></button>)}</div>}</>}</section>}
    </>}
    </div>
  </section>;
}
