import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import InboxPage from "./InboxPage";
import { desktopApi, getDesktopContext, type CustomService, type DesktopContext, type ObsidianNote, type ObsidianTask, type ServiceStatus, type SidebarCounts } from "./desktop";
import { version as browserVersion } from "../package.json";
import type { Update } from "@tauri-apps/plugin-updater";

type Page = "home" | "tasks" | "trending" | "agents" | "notes" | "inbox" | "services";

type Repository = {
  id: number;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  stargazers_count: number;
};

const nav: { id: Page; label: string }[] = [
  { id: "home", label: "首页" },
  { id: "tasks", label: "待办" },
  { id: "trending", label: "热点" },
  { id: "agents", label: "我的 Agent" },
  { id: "notes", label: "笔记" },
  { id: "inbox", label: "收件箱" },
  { id: "services", label: "我的服务" },
];

function currentGreeting(hour: number, hasAlert: boolean) {
  if (hour >= 22 || hour < 6) {
    return hasAlert
      ? { eyebrow: "夜间 · 新加坡", title: "晚上好，这么晚了还没休息。", body: "刚刚检测到一项服务需要你的注意，花一分钟看一下就好。", action: "去查看", target: "services" as Page, icon: "!", kind: "alert" }
      : { eyebrow: "夜间", title: "晚上好，放慢一点。", body: "今天辛苦了，想记录什么都可以写进笔记。", action: "打开笔记", target: "notes" as Page, icon: "☾", kind: "calm" };
  }
  if (hour < 12) return { eyebrow: "上午", title: "早安，开启新的一天。", body: "不妨先看看开发者们正在关注什么，再决定今天的第一件事。", action: "看热点", target: "trending" as Page, icon: "☀", kind: "calm" };
  return { eyebrow: "下午", title: "下午好，保持节奏。", body: "看看待办，选择接下来最想专注的一件事。", action: "查看待办", target: "tasks" as Page, icon: "✓", kind: "calm" };
}

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [clock] = useState(() => new Date().getHours());
  const [night, setNight] = useState(() => { try { const saved = localStorage.getItem("northstar.theme"); if (saved === "night" || saved === "day") return saved === "night"; } catch { /* use the local time */ } const hour = new Date().getHours(); return hour >= 22 || hour < 6; });
  const [desktop, setDesktop] = useState<DesktopContext | null>(null);
  const [sidebarCounts, setSidebarCounts] = useState<SidebarCounts | null>(null);
  const [version, setVersion] = useState(browserVersion);
  const [update, setUpdate] = useState<Update | null>(null);
  const [uiUpdate, setUiUpdate] = useState<{revision: number} | null>(null);
  const [updateState, setUpdateState] = useState("");

  useEffect(() => { void getDesktopContext().then(setDesktop).catch(() => setDesktop(null)); }, []);
  useEffect(() => {
    if (!desktop || desktop.environment === "development") return;
    let active = true;
    void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(value => { if (active) setVersion(value); }).catch(() => undefined);
    let nativeUpdate: Update | null = null, checkingNative = false, lastNativeCheck = 0;
    const closeUpdate = (item: Update | null) => { if (item) void item.close().catch(() => undefined); };
    const checkNative = async () => {
      if (!active || checkingNative || Date.now() - lastNativeCheck < 30000) return;
      checkingNative = true; lastNativeCheck = Date.now();
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const next = await check({ timeout: 15000 });
        if (!active) { closeUpdate(next); return; }
        if (next && nativeUpdate && next.version === nativeUpdate.version) { closeUpdate(next); }
        else { closeUpdate(nativeUpdate); nativeUpdate = next; setUpdate(next); }
        setUpdateState(value => value === "更新检查暂不可用" ? "" : value);
      } catch { if (active && !nativeUpdate) setUpdateState(value => value && value !== "更新检查暂不可用" ? value : "更新检查暂不可用"); }
      finally { checkingNative = false; }
    };
    void checkNative();
    let uiReady = false, checkingUi = false, lastUiCheck = 0;
    const checkUi = async () => {
      if (!active || !uiReady || checkingUi || Date.now() - lastUiCheck < 30000) return;
      checkingUi = true; lastUiCheck = Date.now();
      try { const next = await desktopApi.checkUiUpdate(); if (active) { setUiUpdate(next); setUpdateState(value => value.startsWith("界面更新检查失败：") ? "" : value); } }
      catch (error) { if (active) setUpdateState(`界面更新检查失败：${error instanceof Error ? error.message : String(error)}`); }
      finally { checkingUi = false; }
    };
    void desktopApi.uiUpdateReady().then(() => { if (!active) return; uiReady = true; void checkUi(); }).catch(error => { if (active) setUpdateState(`界面更新检查失败：${error instanceof Error ? error.message : String(error)}`); });
    const checkUpdates = () => { void checkNative(); void checkUi(); };
    const timer = window.setInterval(checkUpdates, 5 * 60 * 1000);
    window.addEventListener("focus", checkUpdates);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", checkUpdates); closeUpdate(nativeUpdate); };
  }, [desktop]);
  const installUpdate = async () => {
    if ((!update && !uiUpdate) || updateState.startsWith("正在")) return;
    if (!update && uiUpdate) {
      setUpdateState("正在应用界面更新…");
      try { await desktopApi.applyUiUpdate(); } catch (error) { setUpdateState(`界面更新失败：${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    if (!update) return;
    setUpdateState("正在下载并安装更新…");
    try { await update.downloadAndInstall(); } catch (error) { setUpdateState(`更新失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  useEffect(() => { if (desktop) void desktopApi.getSidebarCounts().then(setSidebarCounts).catch(() => setSidebarCounts(null)); }, [desktop]);
  const badgeFor = (id: Page) => id === "tasks" ? sidebarCounts?.openTasks : id === "inbox" ? sidebarCounts?.unreadMail : id === "agents" ? desktop?.agents.filter(agent => agent.installed).length : undefined;

  return <div className={`app-shell ${night ? "night" : ""}`} onContextMenu={event => event.preventDefault()}>
    {desktop?.environment === "development" && <div className="development-marker"><strong className="dev-label">开发版 · 测试数据</strong></div>}
    <div className="workspace">
      <aside className="sidebar"><nav aria-label="主导航">{nav.map(item => { const badge = badgeFor(item.id); const icons: Record<Page, string> = { home: "⌂", tasks: "✓", trending: "⌁", agents: "✦", notes: "▤", inbox: "✉", services: "◎" }; return <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)} aria-current={page === item.id ? "page" : undefined}><span className="dock-icon" aria-hidden="true">{icons[item.id]}</span><span className="dock-label">{item.label}</span>{badge !== undefined && badge > 0 && <small className="nav-badge">{badge > 99 ? "99+" : badge}</small>}</button>; })}</nav></aside>
      <main>{page === "home" ? <Home clock={clock} onNavigate={setPage} desktop={desktop} unreadMail={sidebarCounts?.unreadMail} /> : page === "trending" ? <TrendingPage /> : page === "tasks" ? <TasksPage desktop={desktop} /> : page === "notes" ? <NotesPage desktop={desktop} /> : page === "inbox" ? <InboxPage desktop={desktop} /> : page === "services" ? <ServicesPage desktop={desktop} /> : <PageContent page={page} desktop={desktop} />}</main>
    </div><div className="version-indicator"><button className="theme-toggle" onClick={() => setNight(current => { const next = !current; try { localStorage.setItem("northstar.theme", next ? "night" : "day"); } catch { /* retain this session's preference */ } return next; })} aria-label={night ? "切换日间模式" : "切换夜间模式"} title={night ? "切换日间模式" : "切换夜间模式"}>{night ? "☀" : "☾"}</button><span>V{version}</span>{(update || uiUpdate) && <button disabled={updateState.startsWith("正在")} onClick={() => void installUpdate()} aria-label={update ? `更新至版本 ${update.version}` : `应用界面更新 ${uiUpdate?.revision}`}>⬆️</button>}{updateState && <small role="status">{updateState}</small>}</div>
  </div>;
}

function Home({ clock, onNavigate, desktop, unreadMail }: { clock: number; onNavigate: (page: Page) => void; desktop: DesktopContext | null; unreadMail?: number }) {
  const [pending, setPending] = useState<number | null>(null);
  const [todayReminders, setTodayReminders] = useState(0);
  const [serviceAlert, setServiceAlert] = useState<string | null>(null);
  const [serviceCount, setServiceCount] = useState<number | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktopApi.listTasks().then(tasks => {
      if (!active) return;
      const today = new Date().toISOString().slice(0, 10);
      setPending(tasks.filter(task => !task.completed).length);
      setTodayReminders(tasks.filter(task => !task.completed && task.reminderAt?.startsWith(today)).length);
    }).catch(() => undefined);
    void desktopApi.listServices().then(services => {
      if (!active) return;
      setServiceCount(services.length);
      const unhealthy = services.find(service => !service.reachable || service.checks.some(check => !check.healthy));
      setServiceAlert(unhealthy ? `${unhealthy.name} ${unhealthy.reachable ? "有服务异常" : "暂时不可达"}` : null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [desktop]);
  const hasAlert = serviceAlert !== null;
  const greeting = currentGreeting(clock, hasAlert);
  return <section className="home"><div className="home-intro"><h1>{greeting.title}</h1></div><div className="home-stack"><button className="space-card" onClick={() => onNavigate("trending")}><i>⌁</i><b>今日热点</b><span>看看开发者们正在关注什么</span><em>查看热点 →</em></button><button className="space-card" onClick={() => onNavigate("tasks")}><i>✓</i><b>我的待办</b><span>{pending === null ? (desktop ? "正在读取待办…" : "桌面版可读取待办") : pending ? `${pending} 项待办${todayReminders ? ` · ${todayReminders} 项今天提醒` : ""}` : "暂无待办"}</span><em>打开待办 →</em></button><button className="space-card" onClick={() => onNavigate("inbox")}><i>✉</i><b>收件箱</b><span>{!desktop ? "桌面版可查看邮件" : unreadMail === undefined ? "正在读取邮件状态…" : unreadMail > 0 ? `${unreadMail} 封未读邮件` : "查看你的邮件"}</span><em>打开收件箱 →</em></button><button className={`space-card${hasAlert ? " alert" : ""}`} onClick={() => onNavigate("services")}><i>⌁</i><b>我的服务</b><span>{serviceAlert || (serviceCount === null ? (desktop ? "正在探测服务…" : "桌面版可查看服务") : serviceCount ? `${serviceCount} 项服务运行正常` : "尚未登记服务")}</span><em>查看服务 →</em></button></div></section>;
}

function DesktopRequired({ desktop }: { desktop: DesktopContext | null }) {
  return desktop ? null : <div className="empty-state"><b>此功能需要 Windows 桌面版</b><p>浏览器预览无法访问本机 Obsidian Vault。</p></div>;
}

function compactModuleHeader(event: React.UIEvent<HTMLElement>) {
  event.currentTarget.classList.toggle("module-scrolled", event.currentTarget.scrollTop > 32);
}

function TasksPage({ desktop }: { desktop: DesktopContext | null }) {
  const [tasks, setTasks] = useState<ObsidianTask[]>([]);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [editing, setEditing] = useState<ObsidianTask | null>(null);
  const [remind, setRemind] = useState(false); const [reminderAt, setReminderAt] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(Boolean(desktop));
  const load = async () => {
    if (!desktop) return;
    setLoading(true); setError("");
    try { setTasks(await desktopApi.listTasks()); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取待办"); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [desktop]);
  const add = async () => {
    if (!title.trim()) return;
    if (remind && (!reminderAt || new Date(reminderAt).getTime() <= Date.now())) { setError("请选择当前之后的提醒时间并确认"); return; }
    try { if (editing) await desktopApi.changeTask(editing, title, details, remind ? reminderAt : undefined); else await desktopApi.createTask(title, details, remind ? reminderAt : undefined); setTitle(""); setDetails(""); setEditing(null); setRemind(false); setReminderAt(""); setError(""); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存待办"); }
  };
  const toggle = async (task: ObsidianTask) => {
    try { await desktopApi.setTaskCompletion(task.file, task.line, !task.completed); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法更新待办"); }
  };
  const edit = (task: ObsidianTask) => { setEditing(task); setTitle(task.title); setDetails(task.details); setRemind(Boolean(task.reminderAt)); setReminderAt(task.reminderAt || ""); setCreating(true); };
  const remove = async (task: ObsidianTask) => { if (!window.confirm(`删除“${task.title}”？此操作会修改 Obsidian 中的待办文件。`)) return; try { await desktopApi.changeTask(task); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法删除待办"); } };
  const open = tasks.filter(task => !task.completed); const done = tasks.filter(task => task.completed);
  return <section className="module tasks-module" onScroll={compactModuleHeader}><div className="module-sticky"><span>我的待办</span></div><h1>我的待办</h1><DesktopRequired desktop={desktop} />{desktop && <><div className="tasks-board"><TaskGroup title="进行中" tasks={open} loading={loading} onToggle={toggle} onEdit={edit} onDelete={remove} /><TaskGroup title="已完成" tasks={done} loading={loading} onToggle={toggle} onEdit={edit} onDelete={remove} /><section className="task-group task-new"><h2>{editing ? "编辑待办" : "新增待办"}</h2>{creating ? <div className="task-form"><label>标题<input value={title} onChange={event => setTitle(event.target.value)} placeholder="待办标题" /></label><label>事项<textarea value={details} onChange={event => setDetails(event.target.value)} placeholder="补充事项内容" /></label><div className="task-form-actions"><label><input type="checkbox" checked={remind} onChange={event => { setRemind(event.target.checked); setReminderAt(""); }} /> 是否提醒</label><button className="primary" onClick={() => void add()}>{editing ? "保存修改" : "确认创建"}</button></div>{remind && <ReminderPicker value={reminderAt} onChange={setReminderAt} />}</div> : <button className="task-add" onClick={() => setCreating(true)}><span>＋</span>添加一件事</button>}</section></div>{error && <p className="inline-error">{error}</p>}</>}</section>;
}

function TaskGroup({ title, tasks, loading, onToggle, onEdit, onDelete }: { title: string; tasks: ObsidianTask[]; loading: boolean; onToggle: (task: ObsidianTask) => void; onEdit: (task: ObsidianTask) => void; onDelete: (task: ObsidianTask) => void }) {
  return <section className="task-group"><h2>{title}{tasks.length > 0 && <small>{tasks.length}</small>}</h2><div className="module-list">{loading ? <div className="task-row">正在读取 Obsidian 待办…</div> : tasks.length === 0 ? <div className="task-row muted">暂无任务</div> : tasks.map(task => <div className="task-row" key={task.id}><input aria-label={`完成 ${task.title}`} type="checkbox" checked={task.completed} onChange={() => void onToggle(task)} /><span><b>{task.title}</b>{task.details && <small>{task.details}</small>}<small>{task.reminderAt ? `提醒 · ${task.reminderAt.replace("T", " ")} · ` : ""}{task.file}</small>{task.file.replaceAll("\\", "/") === "待办事项/Northstar.md" && <small><button onClick={() => onEdit(task)}>编辑</button> · <button onClick={() => void onDelete(task)}>删除</button></small>}</span></div>)}</div></section>;
}

function ReminderPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [date, setDate] = useState(value.slice(0, 10)); const [time, setTime] = useState(value.slice(11) || "09:00"); const [error, setError] = useState("");
  const now = new Date(); const localToday = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const confirm = () => { const candidate = `${date}T${time}`; if (!date || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(candidate) || new Date(candidate).getTime() <= Date.now()) { setError("请选择当前之后的有效日期和时间"); return; } setError(""); onChange(candidate); };
  return <div className="reminder-picker"><label>日期<input type="date" min={localToday} max="9999-12-31" value={date} onChange={e => { const next = e.target.value; if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) { e.target.value = date; return; } setDate(next); onChange(""); }} /></label><label>时间<input type="time" value={time} onChange={e => { setTime(e.target.value); onChange(""); }} /></label><button type="button" onClick={confirm}>确认时间</button>{value && <small>已确认 {value.replace("T", " ")}</small>}{error && <small className="inline-error">{error}</small>}</div>;
}

const noteSnapshots = new Map<string, ObsidianNote[]>();
function NotesPage({ desktop }: { desktop: DesktopContext | null }) {
  const key = desktop?.environment || "browser";
  const [notes, setNotes] = useState<ObsidianNote[]>(() => noteSnapshots.get(key) || []);
  const [query, setQuery] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ObsidianNote | null>(null); const [content, setContent] = useState(""); const [reading, setReading] = useState(false);
  const search = async (value = query) => { if (!desktop) return; setLoading(true); setError(""); try { const result = await desktopApi.listNotes(value); setNotes(result); if (!value.trim()) noteSnapshots.set(key, result); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法查询笔记"); } finally { setLoading(false); } };
  useEffect(() => { setNotes(noteSnapshots.get(key) || []); void search(""); }, [desktop]);
  const openNote = async (note: ObsidianNote) => { setSelected(note); setContent(""); setReading(true); setError(""); try { setContent(await desktopApi.readNote(note.file)); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取笔记"); } finally { setReading(false); } };
  const createNote = async () => { const title = window.prompt("新笔记名称"); if (!title) return; try { const note = await desktopApi.createNote("", title); setNotes(current => { const next = [note, ...current]; if (!query.trim()) noteSnapshots.set(key, next); return next; }); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建笔记"); } };
  const createDirectory = async () => { const path = window.prompt("新目录名称（相对于 Vault 根目录）"); if (!path) return; try { await desktopApi.createDirectory(path); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建目录"); } };
  return <section className="module notes-module" onScroll={compactModuleHeader}><div className="module-sticky"><span>我的笔记</span></div><h1>我的笔记</h1><DesktopRequired desktop={desktop} />{desktop && <>{selected ? <article className="note-detail"><button className="back" onClick={() => setSelected(null)}>‹ 返回列表</button><h2>{selected.title}</h2><small>{selected.file}</small>{reading ? <p>正在读取笔记…</p> : <div className="note-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({children, href}) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{content || "空笔记"}</ReactMarkdown></div>}</article> : <><div className="note-actions"><button onClick={() => void createDirectory()}>新建目录</button><button onClick={() => void createNote()}>新建笔记</button><button onClick={() => { if (desktop.environment === "development") { setError("开发版使用独立测试 Vault，不会打开正式 Obsidian 仓库。"); } else { window.location.href = "obsidian://open?vault=ObsidianVault"; } }}>跳转 Obsidian</button></div><div className="task-create"><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === "Enter" && void search()} placeholder="查询笔记" /><button className="primary" onClick={() => void search()}>查询笔记</button></div><div className="module-list note-list">{loading && notes.length === 0 ? <div className="task-row">正在索引 Vault…</div> : notes.map(note => <button className="note-row" key={note.file} onClick={() => void openNote(note)}><div><b>{note.title}</b><p>{note.preview}</p><small>{note.file}</small></div><span aria-hidden="true">›</span></button>)}</div></>}{error && <p className="inline-error">{error}</p>}</>}</section>;
}

function TrendingPage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [resultPage, setResultPage] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [updatedAt, setUpdatedAt] = useState("");

  const loadTrending = async () => {
    setStatus("loading");
    const after = new Date();
    after.setDate(after.getDate() - 30);
    const createdAfter = after.toISOString().slice(0, 10);
    try {
      const response = await fetch(`https://api.github.com/search/repositories?q=created:%3E${createdAfter}&sort=stars&order=desc&per_page=10`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      const payload = await response.json() as { items: Repository[] };
      setRepositories(payload.items);
      setResultPage(0);
      setUpdatedAt(new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date()));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  };

  useEffect(() => { void loadTrending(); }, []);

  return <section className="module trending" onScroll={compactModuleHeader}><div className="module-sticky"><span>GitHub 热点</span></div><div className="module-heading"><div><h1>GitHub 热点</h1></div><button className="refresh" onClick={() => void loadTrending()} disabled={status === "loading"}>{status === "loading" ? "加载中…" : "刷新"}</button></div>{status === "error" ? <div className="empty-state"><b>暂时无法连接 GitHub</b><p>请检查网络，稍后再次刷新。</p><button className="primary" onClick={() => void loadTrending()}>重试</button></div> : <div className="repository-list" aria-live="polite">{status === "loading" && Array.from({ length: 4 }).map((_, index) => <div className="repository skeleton" key={index}><span></span><div><b></b><p></p></div></div>)}{status === "ready" && repositories.slice(resultPage * 4, resultPage * 4 + 4).map((repository, index) => <article className="repository" key={repository.id}><span className="rank">{resultPage * 4 + index + 1}</span><div><a href={repository.html_url} target="_blank" rel="noreferrer">{repository.full_name}</a><p>{repository.description || "暂无项目描述"}</p><small>{repository.language || "未标记语言"} · ★ {repository.stargazers_count.toLocaleString()}</small></div><a className="repo-open" href={repository.html_url} target="_blank" rel="noreferrer">打开 ↗</a></article>)}{status === "ready" && <div className="pagination"><span>更新于 {updatedAt} · GitHub API</span><button disabled={resultPage === 0} onClick={() => setResultPage(resultPage - 1)}>上一页</button><span>{resultPage + 1} / {Math.max(1, Math.ceil(repositories.length / 4))}</span><button disabled={(resultPage + 1) * 4 >= repositories.length} onClick={() => setResultPage(resultPage + 1)}>下一页</button></div>}</div>}</section>;
}

function ServicesPage({ desktop }: { desktop: DesktopContext | null }) {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [loading, setLoading] = useState(Boolean(desktop));
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [serviceName, setServiceName] = useState(""); const [serviceTarget, setServiceTarget] = useState(""); const [serviceKind, setServiceKind] = useState<CustomService["kind"]>("http"); const [adding, setAdding] = useState(false);
  const load = async () => {
    if (!desktop) return;
    setLoading(true); setError("");
    try { setServices(await desktopApi.listServices()); setUpdatedAt(new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取服务状态"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [desktop]);
  const addService = async () => { if (!serviceName.trim() || !serviceTarget.trim()) return; setAdding(true); setError(""); try { await desktopApi.registerCustomService(serviceName, serviceTarget, serviceKind); setServiceName(""); setServiceTarget(""); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法登记自定义服务"); } finally { setAdding(false); } };
  const removeService = async (id: string) => { try { await desktopApi.removeCustomService(id); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法移除自定义服务"); } };
  return <section className="module services" onScroll={compactModuleHeader}><div className="module-sticky"><span>我的服务</span></div><div className="module-heading"><div><h1>我的服务</h1></div><button className="refresh" onClick={() => void load()} disabled={loading}>{loading ? "探测中…" : "刷新"}</button></div><DesktopRequired desktop={desktop} />{desktop && <><section className="service-setup"><h2>挂载服务</h2><div className="service-fields"><input value={serviceName} onChange={event => setServiceName(event.target.value)} placeholder="名称，例如：代理订阅" /><select value={serviceKind} onChange={event => setServiceKind(event.target.value as CustomService["kind"])}><option value="http">HTTP(S)</option><option value="tcp">TCP 端口</option></select><input value={serviceTarget} onChange={event => setServiceTarget(event.target.value)} onKeyDown={event => event.key === "Enter" && void addService()} placeholder={serviceKind === "http" ? "https://status.example.com/health" : "host.example.com:443"} /><button className="primary" disabled={adding} onClick={() => void addService()}>{adding ? "保存中…" : "挂载"}</button></div><p>HTTP(S) 以 2xx / 3xx 视为可用；TCP 使用主机:端口进行连接测试。</p></section>{error && <p className="inline-error">{error}</p>}<div className="service-list">{services.map(service => <article className="service-card" key={service.id}><div className="service-card-head"><span className={service.reachable ? "status" : "status warn"}></span><div><h2>{service.name}</h2><p>{service.description}</p></div><small>{service.reachable ? `${service.latencyMs ?? "—"} ms` : "不可达"}</small></div>{service.reachable ? <>{service.id.startsWith("custom-") ? <p className="service-custom-target">{service.hostname}</p> : <div className="service-metrics"><span><b>{service.hostname}</b>主机</span><span><b>{service.uptime}</b>在线时长</span><span><b>{service.load}</b>负载</span><span><b>{service.memory}</b>内存</span><span><b>{service.disk}</b>系统盘</span></div>}<div className="service-checks">{service.checks.map(check => <span key={check.name} className={check.healthy ? "healthy" : "warning"}>● {check.name} · {check.state}</span>)}</div></> : <p className="inline-error">{service.error || "探测失败"}</p>}{service.id.startsWith("custom-") && <button className="service-remove" onClick={() => void removeService(service.id)}>移除挂载</button>}</article>)}{!loading && services.length === 0 && !error && <div className="empty-state"><b>尚未发现服务</b><p>可在 DSH 中添加 SSH 主机，或手动挂载 HTTP / TCP 服务。</p></div>}</div>{updatedAt && <p className="updated service-updated">最近探测：{updatedAt}</p>}</>}</section>;
}

function PageContent({ page, desktop }: { page: Exclude<Page, "home" | "trending" | "tasks" | "notes" | "inbox" | "services">; desktop: DesktopContext | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const agents = desktop?.agents || [];
  const agent = agents.find(item => item.name === selected);
  return <section className="module" onScroll={compactModuleHeader}><div className="module-sticky"><span>我的 Agent</span></div><h1>我的 Agent</h1><DesktopRequired desktop={desktop} />{desktop && <>{agent ? <article className="agent-detail"><button className="back" onClick={() => setSelected(null)}>‹ 返回 Agent 列表</button><div className="agent-detail-head"><span className={agent.installed ? "status" : "status warn"}></span><div><h2>{agent.name}</h2><p>{agent.installed ? "本机已发现，可直接作为工作流入口。" : "本机未发现；不会移除你的历史配置。"}</p></div></div><dl><div><dt>发现状态</dt><dd>{agent.installed ? "已安装" : "未安装"}</dd></div><div><dt>本机位置</dt><dd>{agent.path || "未发现可执行文件或配置目录"}</dd></div><div><dt>优先级</dt><dd>{agent.name === "DSH" ? "默认 Agent" : "可在后续偏好设置中排序"}</dd></div></dl></article> : <div className="module-list">{agents.map(item => <article key={item.name}><span className={item.installed ? "status" : "status warn"}></span><div><b>{item.name} · {item.installed ? "本机已发现" : "未发现"}</b><p>{item.installed ? item.path : "保留历史兼容展示"}</p></div><button onClick={() => setSelected(item.name)}>查看 ›</button></article>)}</div>}</>}</section>;
}
