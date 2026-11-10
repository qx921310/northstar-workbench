import { useEffect, useRef, useState } from "react";
import { desktopApi, type DesktopContext, type GmailSetup, type MailAccount, type MailCategory, type MailMessage } from "./desktop";

type Provider = MailAccount["provider"];
const defaults: Provider[] = ["gmail", "outlook", "qq", "imap"];
const names: Record<Provider, string> = { gmail: "Gmail", outlook: "Outlook", qq: "QQ 邮箱", imap: "其他邮箱" };
const categories: { id: MailCategory; label: string }[] = [
  { id: "all", label: "全部邮件" }, { id: "inbox", label: "收件箱" },
  { id: "unread", label: "未读" }, { id: "read", label: "已读" }, { id: "spam", label: "垃圾邮件" },
];
const sessionSynced = new Set<string>();
const inflightSync = new Map<string, Promise<MailMessage[]>>();
// Bodies are cached in memory only; BODY.PEEK keeps prefetch from marking messages read.
const bodyCache = new Map<string, Promise<MailMessage>>();
function loadBody(environment: string, account: string, category: MailCategory, id: string) {
  const key = JSON.stringify([environment, account, sourceCategory(category), id]);
  const existing = bodyCache.get(key); if (existing) return existing;
  const request = desktopApi.getMailMessage(account, id, sourceCategory(category)).catch(error => { bodyCache.delete(key); throw error; });
  bodyCache.set(key, request);
  if (bodyCache.size > 60) bodyCache.delete(bodyCache.keys().next().value!);
  return request;
}
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
function formatMailDate(value: string, now = new Date()) {
  const date = new Date(value.replace(/\s*\([^)]*\)\s*$/, ""));
  if (Number.isNaN(date.getTime())) return value;
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((today - day) / 86400000);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  if (days === 2) return `前天 ${time}`;
  return `${date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
function reasonText(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function mailCacheKey(environment: string, account: string, category: MailCategory) { return `northstar.mail-cache.v1:${environment}:${account}:${category}`; }
const memoryMailCache = new Map<string, MailMessage[]>();
function readMailCache(key: string): MailMessage[] | null {
  if (memoryMailCache.has(key)) return memoryMailCache.get(key)!;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    if (!Array.isArray(value) || value.length > 20000) return null;
    return value.filter((item): item is MailMessage => item && typeof item.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(item.id) && typeof item.threadId === "string" && typeof item.from === "string" && typeof item.subject === "string" && typeof item.date === "string" && typeof item.snippet === "string" && Array.isArray(item.labels) && item.labels.every((label: unknown) => typeof label === "string"));
  } catch { return null; }
}
function writeMailCache(key: string, messages: MailMessage[]) {
  memoryMailCache.set(key, messages);
  try { localStorage.setItem(key, JSON.stringify(messages.slice(0, 20000).map(({body: _body, htmlBody: _htmlBody, ...metadata}) => metadata))); } catch { /* continue without persistent cache */ }
}
async function syncMessages(accountId: string, category: MailCategory, cached: MailMessage[]): Promise<MailMessage[]> {
  try {
    const result = await desktopApi.syncMailMessages(accountId, category, cached.slice(0, 20).map(item => item.id));
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
  const [hasCache, setHasCache] = useState(false); const [loadingOlder, setLoadingOlder] = useState(false); const [noOlder, setNoOlder] = useState(false);
  const [notice, setNotice] = useState("");
  const [compact, setCompact] = useState(false); const [accountMenu, setAccountMenu] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [batchBusy, setBatchBusy] = useState(false);
  const generation = useRef(0); const dragged = useRef<Provider | null>(null); const dragStart = useRef<{x:number; y:number} | null>(null); const suppressClick = useRef(false);
  const visible = useRef({ accountId, category }); visible.current = { accountId, category };
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
    setSelected(new Set()); setNoOlder(false);
    const source = sourceCategory(category);
    const key = mailCacheKey(desktop.environment, accountId, source);
    const saved = readMailCache(key); const cached = saved ?? [];
    setError(""); setHasCache(saved !== null); setMessages(filterMail(cached, category)); setMessage(null);
    if (sessionSynced.has(key) && saved !== null) { setLoading(false); return; }
    setLoading(true);
    let pending = inflightSync.get(key);
    if (!pending) { pending = syncMessages(accountId, source, cached); inflightSync.set(key, pending); void pending.finally(() => { if (inflightSync.get(key) === pending) inflightSync.delete(key); }).catch(() => undefined); }
    void pending.then(items => { if (request === generation.current) { sessionSynced.add(key); setMessages(filterMail(items, category)); setHasCache(true); writeMailCache(key, items); } })
      .catch(reason => { if (request === generation.current) setError(`${saved !== null ? "同步失败，正在显示本机缓存：" : "同步失败："}${reasonText(reason)}`); })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [accountId, category, desktop]);

  useEffect(() => {
    if (!desktop || !accountId || !messages.length || loading) return;
    let active = true; let index = 0;
    const work = async () => { while (active && index < Math.min(messages.length, 20)) { const item = messages[index++]; try { await loadBody(desktop.environment, accountId, category, item.id); } catch { /* Opening can retry. */ } } };
    void work(); void work();
    return () => { active = false; };
  }, [desktop, accountId, category, messages, loading]);

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
    try { const items = await syncMessages(accountId, source, cached); if (request === generation.current) { sessionSynced.add(key); setMessages(filterMail(items, category)); setHasCache(true); writeMailCache(key, items); } }
    catch (reason) { if (request === generation.current) setError(`${saved !== null ? "同步失败，正在显示本机缓存：" : "同步失败："}${reasonText(reason)}`); }
    finally { if (request === generation.current) setLoading(false); }
  };
  const loadOlder = async () => {
    if (!desktop || !accountId || loadingOlder) return;
    const source = sourceCategory(category); const key = mailCacheKey(desktop.environment, accountId, source); const cached = readMailCache(key) || [];
    const last = cached[cached.length - 1]; if (!last) { setNoOlder(true); return; }
    const requestedAccount = accountId; const request = generation.current; setLoadingOlder(true); setError("");
    try { const older = await desktopApi.listOlderMail(accountId, source, last.id); if (request !== generation.current) return; const latest = readMailCache(key) || []; const seen = new Set(latest.map(m => m.id)); const merged = [...latest, ...older.filter(m => !seen.has(m.id))]; writeMailCache(key, merged); if (visible.current.accountId === requestedAccount && sourceCategory(visible.current.category) === source) setMessages(filterMail(merged, visible.current.category)); setNoOlder(older.length < 50); }
    catch (reason) { setError(`读取历史邮件失败：${reasonText(reason)}`); } finally { setLoadingOlder(false); }
  };
  const openMessage = async (item: MailMessage) => {
    const request = ++generation.current; setLoading(true); setError("");
    try {
      const result = await loadBody(desktop?.environment || "production", accountId, category, item.id);
      if (request !== generation.current) return;
      setMessage(result);
      if (item.labels.includes("UNREAD")) {
        try {
          await desktopApi.markMailRead(accountId, item.id, category);
          const env = desktop?.environment || "production";
          const source = sourceCategory(category);
          const key = mailCacheKey(env, accountId, source);
          const current = readMailCache(key);
          if (current) writeMailCache(key, current.map(mail => mail.id === item.id ? { ...mail, labels: mail.labels.filter(label => label !== "UNREAD") } : mail));
          // IMAP UIDs differ across folders; refresh those snapshots on next visit.
          for (const folder of ["all", "inbox", "spam"] as const) if (folder !== source) { const other = mailCacheKey(env, accountId, folder); sessionSynced.delete(other); memoryMailCache.delete(other); try { localStorage.removeItem(other); } catch { /* no persistent cache */ } }
          if (request === generation.current) setMessages(current => filterMail(current.map(mail => mail.id === item.id ? { ...mail, labels: mail.labels.filter(label => label !== "UNREAD") } : mail), category));
        } catch (reason) { if (request === generation.current) setError(`正文已打开，但未能同步已读状态：${reasonText(reason)}`); }
      }
    } catch (reason) { if (request === generation.current) setError(reasonText(reason)); }
    finally { if (request === generation.current) setLoading(false); }
  };
  const batchAction = async (action: "read" | "trash" | "spam") => {
    if (!accountId || !selected.size || batchBusy) return;
    const ids = [...selected]; const request = ++generation.current; setBatchBusy(true); setError("");
    try {
      const result: {succeeded:string[];failed:{id:string;error:string}[]} = {succeeded:[], failed:[]};
      for (let i=0; i<ids.length; i+=20) { const chunk=ids.slice(i,i+20); try { const part=await desktopApi.batchMailAction(accountId, chunk, category, action); result.succeeded.push(...part.succeeded); result.failed.push(...part.failed); } catch (reason) { result.failed.push(...chunk.map(id => ({id, error:reasonText(reason)}))); } }
      const done = new Set(result.succeeded); const env = desktop?.environment || "production";
      const source = sourceCategory(category); const key = mailCacheKey(env, accountId, source);
      const update = (items: MailMessage[]) => action === "read" ? items.map(item => done.has(item.id) ? {...item, labels: item.labels.filter(label => label !== "UNREAD")} : item) : items.filter(item => !done.has(item.id));
      const cached = readMailCache(key); if (cached) writeMailCache(key, update(cached));
      if (visible.current.accountId === accountId && sourceCategory(visible.current.category) === source) setMessages(items => filterMail(update(items), visible.current.category));
      if (request === generation.current) setSelected(current => new Set([...current].filter(id => !done.has(id))));
      if (done.size) {
        for (const folder of ["all", "inbox", "spam"] as const) if (folder !== source) { const other = mailCacheKey(env, accountId, folder); sessionSynced.delete(other); memoryMailCache.delete(other); try { localStorage.removeItem(other); } catch { /* no persistent cache */ } }
        if (action !== "read") for (const cacheKey of bodyCache.keys()) { try { const parts = JSON.parse(cacheKey); if (parts[0] === env && parts[1] === accountId && done.has(parts[3])) bodyCache.delete(cacheKey); } catch { /* ignore */ } }
      }
      if (request === generation.current) { if (result.failed.length) setError(`已处理 ${result.succeeded.length} 封，${result.failed.length} 封未确认：${result.failed[0].error}。请刷新核对。`); else setNotice(`已处理 ${result.succeeded.length} 封邮件`); }
    } catch (reason) { if (request === generation.current) setError(`邮件操作未完成：${reasonText(reason)}。请刷新核对。`); }
    finally { setBatchBusy(false); }
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
      {order.map((item, index) => <div key={item} className={`mail-provider-item${provider === item ? " active" : ""}`} data-provider={item}>
        <button role="tab" aria-selected={provider === item} className="mail-provider-select"
          onKeyDown={event => { if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const target = index + (event.key === "ArrowLeft" ? -1 : 1); if (target >= 0 && target < order.length) reorder(item, order[target]); }}
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setAccountMenu(false); if (item !== provider) { generation.current++; setAccountId(""); setMessages([]); setMessage(null); setError(""); setShowSetup(false); setProvider(item); setCategory("all"); } }}>
          <span className={`mail-provider-icon ${item}`}>{item === "gmail" ? "M" : item === "outlook" ? "O" : item === "qq" ? "Q" : "✉"}</span><span className="provider-name">{names[item]}</span></button>
        {provider === item && item === "gmail" && connected.length > 0 && <div className="provider-account"><button className="account-trigger" aria-label="选择邮箱账号" aria-expanded={accountMenu} onClick={() => setAccountMenu(v => !v)}><span>{connected.find(a => a.id === accountId)?.address}</span><span aria-hidden="true">⌄</span></button>{accountMenu && <div className="account-menu" role="menu">{connected.map(a => <button key={a.id} role="menuitem" onClick={() => { setAccountId(a.id); setAccountMenu(false); setShowSetup(false); }}>{a.address}{accountId === a.id ? " ✓" : ""}</button>)}<button role="menuitem" onClick={() => { setShowSetup(true); setAccountMenu(false); }}>＋ 添加账号</button></div>}</div>}
        <span className="drag-hint" role="button" tabIndex={0} aria-label={`拖动排序 ${names[item]}`} title="拖动调整顺序"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); dragged.current = item; dragStart.current = {x:event.clientX,y:event.clientY}; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerUp={event => { const start = dragStart.current; const source = dragged.current; const moved = start && Math.hypot(event.clientX-start.x,event.clientY-start.y)>5; if (source && moved) { const target = document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>("[data-provider]")?.dataset.provider as Provider | undefined; if (target && defaults.includes(target)) reorder(source,target); suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 100); } dragged.current=null; dragStart.current=null; }}
          onPointerCancel={() => { dragged.current=null; dragStart.current=null; }}>⠿</span>
      </div>)}
    </div><span className="sr-only" aria-live="polite">{notice}</span>
    <div className="mail-category-bar" aria-label="邮件分类">{message && <button className="back mail-back" aria-label="返回列表" onClick={() => setMessage(null)}>←</button>}{categories.map(item => <button key={item.id} className={category === item.id ? "active" : ""} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>)}{connected.length > 0 && <button className="mail-refresh-icon" aria-label="刷新邮件" title="刷新邮件" disabled={loading || !accountId} onClick={() => void refresh()}>⟳</button>}</div>
    </div>
    <div className="inbox-content" onScroll={event => setCompact(event.currentTarget.scrollTop > 32)}>
    {!desktop ? <div className="mail-placeholder"><b>请在 Windows 桌面版连接邮箱</b><p>桌面版可安全读取本机邮箱凭据。</p></div> : provider !== "gmail" ? <div className="mail-placeholder"><div className="mail-empty-icon">✉</div><b>{names[provider]}暂未接入</b><p>这个邮箱的授权和同步还在建设中。</p></div> : <>

      {(showSetup || connected.length === 0) && <section className="mail-setup"><div className="setup-heading"><h2>{connected.length ? "添加 Gmail" : "连接 Gmail"}</h2>{connected.length > 0 && <button aria-label="关闭添加账号" onClick={() => setShowSetup(false)}>×</button>}</div><div className="gmail-methods"><button className={method === "app_password" ? "selected" : ""} onClick={() => setMethod("app_password")}>应用专用密码</button><button className={method === "oauth" ? "selected" : ""} onClick={() => setMethod("oauth")}>Google 授权（高级）</button></div>
        {method === "app_password" ? <div className="gmail-connect"><p>输入 Gmail 地址和应用专用密码，连接后自动同步邮件。</p><div className="mail-fields"><input type="email" value={address} onChange={event => setAddress(event.target.value)} placeholder="Gmail 地址" aria-label="Gmail 地址" /><input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="应用专用密码" aria-label="应用专用密码" /><button className="primary" disabled={busy || !address.trim() || !password.trim()} onClick={() => void connect()}>{busy ? "正在连接…" : "连接 Gmail"}</button></div><p>首次使用需要开启 Google 两步验证并生成密码。 <button type="button" className="gmail-help-link" onClick={() => void desktopApi.openGmailAppPasswords().catch(reason => setError(reasonText(reason)))}>打开 Google 设置 ↗</button></p></div> : <div className="gmail-connect">{!setup?.configured ? <><p>填写 Google 桌面客户端 ID。</p><div className="mail-fields"><input className="gmail-client-id" value={clientId} onChange={event => setClientId(event.target.value)} placeholder="123…apps.googleusercontent.com" /><button className="primary" disabled={busy || !clientId.trim()} onClick={() => void saveId()}>保存 Client ID</button></div></> : <><p>已配置 Client ID（{setup.clientIdHint}），授权令牌保存在本机。</p><div className="gmail-secret"><input type="password" autoComplete="off" value={clientSecret} onChange={event => setClientSecret(event.target.value)} aria-label="Google 客户端密钥" placeholder={setup.clientSecretConfigured ? "替换客户端密钥（可选）" : "Google 客户端密钥"} /><button disabled={busy || !clientSecret.trim()} onClick={() => void saveSecret()}>保存密钥</button></div><div className="gmail-actions"><button className="primary" disabled={busy} onClick={() => void connect()}>{busy ? "等待浏览器授权…" : "连接 Gmail"}</button>{busy && <button disabled={cancelling} onClick={() => { setCancelling(true); void desktopApi.cancelGmailAuth().catch(reason => { setError(reasonText(reason)); setCancelling(false); }); }}>取消授权</button>}</div></>}</div>}
        <p className="setup-note">凭据保存在 Windows 凭据管理器；阅读邮件会同步已读状态。</p></section>}
      {error && <p role="alert" className="inline-error">{error}</p>}
      {connected.length > 0 && <section className="mail-reader">{message ? <article className="message-detail"><h2>{message.subject || "（无主题）"}</h2><p className="message-meta">{message.from} · {formatMailDate(message.date)}</p>{message.htmlBody ? <div className="message-html" dangerouslySetInnerHTML={{ __html: message.htmlBody.replaceAll(" data-remote-src=", " src=") }} /> : <pre>{message.body || message.snippet || "此邮件没有可显示的正文。"}</pre>}</article> : <><div className="mail-list-heading"><b>{categories.find(item => item.id === category)?.label}</b><span>{category === "read" || category === "unread" ? "按已加载邮件筛选" : "按需加载历史邮件"}</span></div>{loading && !hasCache ? <div className="mail-placeholder"><p>正在同步邮件…</p></div> : messages.length === 0 ? <div className="mail-placeholder"><div className="mail-empty-icon">✉</div><b>这里暂时没有邮件</b><p>试试其他分类，或刷新列表。</p>{!noOlder && hasCache && <button className="load-older-mail" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "加载中…" : "加载更早邮件"}</button>}</div> : <><div className="mail-batch-toolbar"><label><input type="checkbox" aria-label="全选当前邮件" checked={messages.length > 0 && messages.every(item => selected.has(item.id))} onChange={event => setSelected(event.target.checked ? new Set(messages.map(item => item.id)) : new Set())} />全选</label><span>{selected.size ? `已选 ${selected.size} 封` : "选择邮件进行批量操作"}</span><button disabled={!selected.size || batchBusy} onClick={() => void batchAction("read")}>{batchBusy ? "正在处理…" : "标为已读"}</button><button disabled={!selected.size || batchBusy} onClick={() => void batchAction("trash")}>删除</button><button disabled={!selected.size || batchBusy || category === "spam"} onClick={() => void batchAction("spam")}>标记垃圾邮件</button></div><div className="message-list">{messages.map(item => <div className="mail-select-row" key={item.id}><input type="checkbox" aria-label={`选择邮件 ${item.subject || "无主题"}`} checked={selected.has(item.id)} disabled={batchBusy} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })}/><button onClick={() => void openMessage(item)}><span className={item.labels.includes("UNREAD") ? "mail-unread-dot" : "mail-read-dot"} aria-label={item.labels.includes("UNREAD") ? "未读" : "已读"}></span><div><b>{item.subject || "（无主题）"}</b><span>{item.from}</span>{item.snippet && <p>{item.snippet}</p>}</div><small title={item.date}>{formatMailDate(item.date)}</small></button></div>)}</div>{!noOlder && <button className="load-older-mail" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "加载中…" : "加载更早邮件"}</button>}</>}</>}</section>}
    </>}
    </div>
  </section>;
}
