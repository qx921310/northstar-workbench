import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import remarkGfm from "remark-gfm";
import InboxPage from "./InboxPage";
import { DesignIcon } from "./DesignIcon";
import { desktopApi, getDesktopContext, type CustomService, type DesktopContext, type LocalNote, type ObsidianNote, type ObsidianTask, type ServiceStatus, type SidebarCounts } from "./desktop";
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

type ServiceSnapshot = {items:ServiceStatus[]; fetchedAt:number};
let serviceSnapshot:ServiceSnapshot | null = null;
let serviceRequest:Promise<ServiceSnapshot> | null = null;
function loadServiceSnapshot(force=false):Promise<ServiceSnapshot> {
  if(!force && serviceSnapshot && Date.now()-serviceSnapshot.fetchedAt<60_000)return Promise.resolve(serviceSnapshot);
  if(serviceRequest)return force ? serviceRequest.catch(()=>undefined).then(()=>loadServiceSnapshot(true)) : serviceRequest;
  serviceRequest=desktopApi.listServices().then(items=>{const result={items,fetchedAt:Date.now()};serviceSnapshot=result;return result;}).finally(()=>{serviceRequest=null;});return serviceRequest;
}
function currentGreeting(hour: number, hasAlert: boolean) {
  if (hour >= 18 || hour < 6) {
    return hasAlert
      ? { eyebrow: "夜间 · 新加坡", title: "晚上好，这么晚了还没休息。", body: "刚刚检测到一项服务需要你的注意，花一分钟看一下就好。", action: "去查看", target: "services" as Page, icon: "!", kind: "alert" }
      : { eyebrow: "夜间", title: "晚上好，放慢一点。", body: "今天辛苦了，想记录什么都可以写进笔记。", action: "打开笔记", target: "notes" as Page, icon: "☾", kind: "calm" };
  }
  if (hour < 12) return { eyebrow: "上午", title: "早安，开启新的一天。", body: "不妨先看看开发者们正在关注什么，再决定今天的第一件事。", action: "看热点", target: "trending" as Page, icon: "☀", kind: "calm" };
  return { eyebrow: "下午", title: "下午好，保持节奏。", body: "看看待办，选择接下来最想专注的一件事。", action: "查看待办", target: "tasks" as Page, icon: "✓", kind: "calm" };
}

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [clock, setClock] = useState(() => new Date().getHours());
  useEffect(() => { const refresh = () => setClock(new Date().getHours()); const timer = window.setInterval(refresh, 30000); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh); return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); }; }, []);
  const [night, setNight] = useState(() => { try { const saved = localStorage.getItem("northstar.theme"); if (saved === "night" || saved === "day") return saved === "night"; } catch { /* use the local time */ } const hour = new Date().getHours(); return hour >= 22 || hour < 6; });
  const [desktop, setDesktop] = useState<DesktopContext | null>(null);
  const [sidebarCounts, setSidebarCounts] = useState<SidebarCounts | null>(null);
  const [version, setVersion] = useState(browserVersion);
  const [update, setUpdate] = useState<Update | null>(null);
  const [uiUpdate, setUiUpdate] = useState<{revision: number} | null>(null);
  const [updateState, setUpdateState] = useState("");

  useEffect(() => { void getDesktopContext().then(setDesktop).catch(() => setDesktop(null)); }, []);
  useEffect(() => { if(desktop) void loadServiceSnapshot().catch(()=>undefined); },[desktop]);
  useEffect(() => {
    if (!desktop || desktop.environment === "development") return;
    let active = true;
    const shellVersion = import("@tauri-apps/api/app").then(({ getVersion }) => getVersion());
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
    void Promise.all([shellVersion, desktopApi.uiUpdateReady()]).then(([base, revision]) => {
      if (!active) return;
      const parts = base.split(".").map(Number);
      if (parts.length === 3 && parts.every(Number.isSafeInteger) && Number.isSafeInteger(revision) && revision >= 0) setVersion(`${parts[0]}.${parts[1]}.${parts[2] + revision}`);
      else setVersion(base);
      uiReady = true; void checkUi();
    }).catch(error => { if (active) setUpdateState(`界面更新检查失败：${error instanceof Error ? error.message : String(error)}`); });
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
  const badgeFor = (id: Page) => id === "inbox" ? sidebarCounts?.unreadMail : undefined;

  const isDesktopWindow = "__TAURI_INTERNALS__" in window;
  return <div className={`app-shell ${night ? "night" : ""} ${isDesktopWindow ? "desktop-shell" : ""}`} onContextMenu={event => event.preventDefault()}>
    {isDesktopWindow && <WindowChrome />}
    {desktop?.environment === "development" && <div className="development-marker"><strong className="dev-label">开发版 · 测试数据</strong></div>}
    <div className="workspace">
      <aside className="sidebar"><nav aria-label="主导航">{nav.map(item => { const badge = badgeFor(item.id); return <button key={item.id} aria-label={item.label} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)} aria-current={page === item.id ? "page" : undefined}><span className="dock-icon" aria-hidden="true"><DesignIcon name={item.id}/></span><span className="dock-label">{item.label}</span>{badge !== undefined && badge > 0 && <small className="nav-badge">{badge > 99 ? "99+" : badge}</small>}</button>; })}</nav></aside>
      <main>{page === "home" ? <Home clock={clock} onNavigate={setPage} desktop={desktop} unreadMail={sidebarCounts?.unreadMail} /> : page === "trending" ? <TrendingPage /> : page === "tasks" ? <TasksPage desktop={desktop} /> : page === "notes" ? <NotesPage desktop={desktop} /> : page === "inbox" ? <InboxPage desktop={desktop} /> : page === "services" ? <ServicesPage desktop={desktop} /> : <PageContent desktop={desktop} />}</main>
    </div><div className="version-indicator">{desktop && <ReminderCenter desktop={desktop} onOpenTasks={() => setPage("tasks")} />}<button className="theme-toggle" onClick={() => setNight(current => { const next = !current; try { localStorage.setItem("northstar.theme", next ? "night" : "day"); } catch { /* retain this session's preference */ } return next; })} aria-label={night ? "切换日间模式" : "切换夜间模式"} title={night ? "切换日间模式" : "切换夜间模式"}><DesignIcon name={night ? "sun" : "moon"}/></button><span>V{version}</span>{(update || uiUpdate) && <button disabled={updateState.startsWith("正在")} onClick={() => void installUpdate()} aria-label={update ? `更新至版本 ${update.version}` : `应用界面更新 ${uiUpdate?.revision}`}>⬆️</button>}{updateState && <small role="status">{updateState}</small>}</div>
  </div>;
}

function WindowChrome() {
  const run = async (action: "minimize" | "toggleMaximize" | "close") => {
    try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow()[action](); }
    catch (error) { console.error("窗口操作失败", error); }
  };
  return <>
    <div className="window-drag-region" data-tauri-drag-region />
    <div className="window-controls" role="group" aria-label="窗口操作">
      <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => void run("minimize")}><DesignIcon name="minimize" /></button>
      <button type="button" aria-label="最大化或还原窗口" title="最大化或还原" onClick={() => void run("toggleMaximize")}><DesignIcon name="maximize" /></button>
      <button type="button" className="window-close" aria-label="关闭窗口" title="关闭" onClick={() => void run("close")}><DesignIcon name="close" /></button>
    </div>
  </>;
}

function ReminderCenter({ desktop, onOpenTasks }: { desktop: DesktopContext; onOpenTasks: () => void }) {
  const key = `northstar.reminders.dismissed.v1:${desktop.environment}`;
  const [items, setItems] = useState<ObsidianTask[]>([]); const [open, setOpen] = useState(false); const seen = useRef(new Set<string>()); const dismissedSession = useRef(new Set<string>());
  const identity = (task: ObsidianTask) => `${task.id}|${task.reminderAt}`;
  const dismissed = () => { try { const value: unknown = JSON.parse(localStorage.getItem(key) || "[]"); return new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []); } catch { return new Set<string>(); } };
  useEffect(() => { let active = true; const check = async () => { try { const all = await desktopApi.listTasks(); if (!active) return; const acknowledged = dismissed(); const due = all.filter(task => !task.completed && task.reminderAt && !Number.isNaN(new Date(task.reminderAt).getTime()) && new Date(task.reminderAt).getTime() <= Date.now() && !acknowledged.has(identity(task)) && !dismissedSession.current.has(identity(task))); if (due.some(task => !seen.current.has(identity(task)))) setOpen(true); due.forEach(task => seen.current.add(identity(task))); if (due.length) { try {const deliveredKey=`northstar.reminders.delivered.v1:${desktop.environment}`;const old:unknown=JSON.parse(localStorage.getItem(deliveredKey)||"[]");const merged=new Set(Array.isArray(old) ? old.filter((x):x is string=>typeof x==="string") : []);due.forEach(task=>merged.add(identity(task)));localStorage.setItem(deliveredKey,JSON.stringify([...merged].slice(-500)));window.dispatchEvent(new Event("northstar-reminders-changed"));}catch{/* keep reminders usable in memory */} } setItems(due); } catch { /* Tasks page reports its own load failures. */ } }; void check(); const timer = window.setInterval(check, 15000); window.addEventListener("focus", check); return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", check); }; }, [desktop]);
  const dismiss = (task: ObsidianTask) => { const next = dismissed(); next.add(identity(task)); dismissedSession.current.add(identity(task)); try { localStorage.setItem(key, JSON.stringify([...next].slice(-500))); } catch { /* current session only */ } setItems(current => current.filter(item => identity(item) !== identity(task))); };
  return <div className="reminder-center"><button className="reminder-bell" aria-label="待办提醒" aria-expanded={open} onClick={() => setOpen(value => !value)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-2 7-2 9h16c0-2-2-2-2-9"/><path d="M10 20h4"/></svg>{items.length > 0 && <i aria-label="有待办提醒"/>}</button>{open && <section className="reminder-panel" aria-label="待办提醒列表"><div className="reminder-panel-heading"><b>待办提醒</b><button aria-label="关闭提醒" onClick={() => setOpen(false)}>×</button></div>{items.length ? items.map(task => <article key={identity(task)}><button className="reminder-task" onClick={() => { setOpen(false); onOpenTasks(); }}><b>{task.title}</b><small>{task.reminderAt?.replace("T", " ")}</small></button><button aria-label={`关闭 ${task.title} 提醒`} onClick={() => dismiss(task)}>×</button></article>) : <p>暂无待办提醒</p>}</section>}</div>;
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
    void loadServiceSnapshot().then(({items:services}) => {
      if (!active) return;
      setServiceCount(services.length);
      const unhealthy = services.find(service => !service.reachable || service.checks.some(check => !check.healthy));
      setServiceAlert(unhealthy ? `${unhealthy.name} ${unhealthy.reachable ? "有服务异常" : "暂时不可达"}` : null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [desktop]);
  const hasAlert = serviceAlert !== null;
  const greeting = currentGreeting(clock, hasAlert);
  return <section className="home"><div className="home-composition"><div className="home-intro"><h1>{greeting.title}</h1></div><div className="home-stack"><button className="space-card" onClick={() => onNavigate("trending")}><i><DesignIcon name="trending"/></i><b>今日热点</b><span>看看开发者们正在关注什么</span><em>查看热点 →</em></button><button className="space-card" onClick={() => onNavigate("tasks")}><i><DesignIcon name="tasks"/></i><b>我的待办</b><span>{pending === null ? (desktop ? "正在读取待办…" : "桌面版可读取待办") : pending ? `${pending} 项待办${todayReminders ? ` · ${todayReminders} 项今天提醒` : ""}` : "暂无待办"}</span><em>打开待办 →</em></button><button className="space-card" onClick={() => onNavigate("inbox")}><i><DesignIcon name="inbox"/></i><b>收件箱</b><span>{!desktop ? "桌面版可查看邮件" : unreadMail === undefined ? "正在读取邮件状态…" : unreadMail > 0 ? `${unreadMail} 封未读邮件` : "查看你的邮件"}</span><em>打开收件箱 →</em></button><button className={`space-card${hasAlert ? " alert" : ""}`} onClick={() => onNavigate("services")}><i><DesignIcon name="services"/></i><b>我的服务</b><span>{serviceAlert || (serviceCount === null ? (desktop ? "正在探测服务…" : "桌面版可查看服务") : serviceCount ? `${serviceCount} 项服务运行正常` : "尚未登记服务")}</span><em>查看服务 →</em></button></div></div></section>;
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
  const [details, setDetails] = useState<string[]>([""]);
  const [editing, setEditing] = useState<ObsidianTask | null>(null); const [deleting, setDeleting] = useState<ObsidianTask | null>(null);
  const [remind, setRemind] = useState(false); const [reminderAt, setReminderAt] = useState(""); const [reminderValid,setReminderValid]=useState(true);
  const [error, setError] = useState(""); const [taskNotice, setTaskNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(Boolean(desktop)); const [saving, setSaving] = useState(false); const [updating, setUpdating] = useState(false);
  const load = async () => {
    if (!desktop) return;
    setLoading(true); setError("");
    try { setTasks(await desktopApi.listTasks()); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取待办"); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [desktop]);
  const add = async () => {
    if (!title.trim()) { setError("请输入待办标题"); return; }
    if (saving) return;
    if (remind && (!reminderAt || Number.isNaN(new Date(reminderAt).getTime()))) { setError("请选择提醒日期和时间并确认"); return; }
    const text = details.map(item => item.trim()).filter(Boolean).join("\n");
    setSaving(true); setTaskNotice("");
    try { const created = await desktopApi.createTask(title, text, remind ? reminderAt : undefined); setTasks(current => [created, ...current.filter(item => item.id !== created.id)]); setTitle(""); setDetails([""]); setRemind(false); setReminderAt(""); setError(""); setTaskNotice("待办已创建"); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存待办"); } finally { setSaving(false); }
  };
  const toggle = async (task: ObsidianTask) => {
    try { await desktopApi.setTaskCompletion(task.file, task.line, !task.completed); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法更新待办"); }
  };
  const toggleItem = async (task: ObsidianTask, item: number, completed: boolean) => {
    if (updating) return; setUpdating(true); setError("");
    setTasks(current => current.map(value => { if (value.id !== task.id) return value; const count = value.details.split(/\r?\n/).filter(line => line.trim()).length; const states = Array.from({length:count}, (_, index) => index === item ? completed : Boolean(value.itemStates?.[index])); return {...value, itemStates:states, completed:states.length > 0 && states.every(Boolean)}; }));
    try { await desktopApi.setTaskItem(task, item, completed); await load(); } catch (reason) { setTasks(current => current.map(value => value.id === task.id ? task : value)); await load(); setError(reason instanceof Error ? reason.message : "无法更新事项"); } finally { setUpdating(false); }
  };
  const edit = (task: ObsidianTask) => { setEditing(task); setError(""); };
  const remove = (task: ObsidianTask) => setDeleting(task);
  const confirmDelete = async () => { if (!deleting || updating) return; setUpdating(true); try { await desktopApi.changeTask(deleting); setDeleting(null); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法删除待办"); setDeleting(null); } finally { setUpdating(false); } };
  const open = tasks.filter(task => !task.completed); const done = tasks.filter(task => task.completed);
  return <section className="module tasks-module" onScroll={compactModuleHeader}><div className="module-sticky"><span>我的待办</span></div><h1>我的待办</h1><DesktopRequired desktop={desktop} />{desktop && <><div className="tasks-board"><TaskGroup title="进行中" tasks={open} loading={loading} onToggle={toggle} onToggleItem={toggleItem} updating={updating} onEdit={edit} onDelete={remove} /><TaskGroup title="已完成" tasks={done} loading={loading} onToggle={toggle} onToggleItem={toggleItem} updating={updating} onEdit={edit} onDelete={remove} /><section className="task-group task-new"><h2>新增待办</h2>{taskNotice && <p className="task-notice" role="status">{taskNotice}</p>}{creating ? <div className="task-form"><label>标题<input value={title} aria-invalid={Boolean(error && !title.trim())} onChange={event => { setTitle(event.target.value); if (error === "请输入待办标题") setError(""); }} placeholder="待办标题" /></label>{error && <p className="inline-error" role="alert">{error}</p>}<div className="task-details"><span>事项</span>{details.map((item, index) => <div className="task-detail-entry" key={index}><input aria-label={`事项 ${index + 1}`} value={item} onChange={event => setDetails(current => current.map((value, i) => i === index ? event.target.value : value))} placeholder="补充事项内容" /><div className="task-detail-buttons"><button type="button" aria-label={`在事项 ${index + 1} 后增加`} onClick={() => setDetails(current => [...current.slice(0, index + 1), "", ...current.slice(index + 1)])}>＋</button>{index > 0 && <button type="button" aria-label={`删除事项 ${index + 1}`} onClick={() => setDetails(current => current.filter((_, i) => i !== index))}>−</button>}</div></div>)}</div><div className="reminder-row"><label><input type="checkbox" checked={remind} onChange={event => { setRemind(event.target.checked); setReminderAt(event.target.checked ? nextMinute() : ""); setReminderValid(true); }} /> 是否提醒</label>{remind && <CompactReminder value={reminderAt} onChange={setReminderAt} onValidityChange={setReminderValid} />}</div><button className="primary task-submit" disabled={saving || (remind && !reminderValid)} onClick={() => void add()}>{saving ? "保存中…" : "确认创建"}</button></div> : <button className="task-add" onClick={() => setCreating(true)}><span>＋</span>添加一件事</button>}</section></div>{error && !creating && <p className="inline-error" role="alert">{error}</p>}{deleting && <div className="dialog-overlay"><section role="alertdialog" aria-modal="true" aria-labelledby="delete-task-title" className="task-confirm-dialog"><h2 id="delete-task-title">确认删除</h2><p>是否删除该待办，删除后无法恢复！</p><div><button className="cancel-delete" disabled={updating} onClick={() => setDeleting(null)}>取消</button><button className="confirm-delete" disabled={updating} onClick={() => void confirmDelete()}>删除</button></div></section></div>}{editing && <TaskEditDialog task={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}</>}</section>;
}

function TaskEditDialog({ task, onClose, onSaved }: { task: ObsidianTask; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState(task.title); const [details, setDetails] = useState(task.details ? task.details.split(/\r?\n/) : [""]);
  const [remind, setRemind] = useState(Boolean(task.reminderAt)); const [reminderAt, setReminderAt] = useState(task.reminderAt || ""); const [reminderValid,setReminderValid]=useState(true); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const save = async () => { if (!title.trim()) { setError("请输入待办标题"); return; } if (remind && !reminderAt) { setError("请选择并确认提醒时间"); return; } if (saving) return; setSaving(true); setError(""); try { await desktopApi.changeTask(task, title, details.map(item => item.trim()).filter(Boolean).join("\n"), remind ? reminderAt : undefined); await onSaved(); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存待办"); } finally { setSaving(false); } };
  return <div className="dialog-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}><section className="task-edit-dialog" role="dialog" aria-modal="true" aria-label="编辑待办"><div className="dialog-heading"><h2>编辑待办</h2><button type="button" aria-label="关闭编辑" disabled={saving} onClick={onClose}>×</button></div><div className="task-form"><label>标题<input value={title} onChange={event => setTitle(event.target.value)} placeholder="待办标题" /></label><div className="task-details"><span>事项</span>{details.map((item, index) => <div className="task-detail-entry" key={index}><input aria-label={`编辑事项 ${index + 1}`} value={item} onChange={event => setDetails(current => current.map((value, i) => i === index ? event.target.value : value))} /><div className="task-detail-buttons"><button type="button" aria-label={`增加编辑事项 ${index + 1}`} onClick={() => setDetails(current => [...current.slice(0,index+1), "", ...current.slice(index+1)])}>＋</button>{index > 0 && <button type="button" aria-label={`删除编辑事项 ${index + 1}`} onClick={() => setDetails(current => current.filter((_,i) => i !== index))}>−</button>}</div></div>)}</div><div className="reminder-row"><label className="edit-remind"><input type="checkbox" checked={remind} onChange={event => { setRemind(event.target.checked); if (!event.target.checked) setReminderAt(""); else if (!reminderAt) setReminderAt(nextMinute()); setReminderValid(true); }} />是否提醒</label>{remind && <CompactReminder value={reminderAt} onChange={setReminderAt} onValidityChange={setReminderValid} />}</div>{error && <p role="alert" className="inline-error">{error}</p>}<div className="dialog-actions"><button onClick={onClose} disabled={saving}>取消</button><button className="primary" onClick={() => void save()} disabled={saving || (remind && !reminderValid)}>{saving ? "保存中…" : "保存修改"}</button></div></div></section></div>;
}

function TaskDetails({ task, onToggleItem, updating }: { task: ObsidianTask; updating: boolean; onToggleItem: (task: ObsidianTask, item: number, completed: boolean) => void }) {
  const items = task.details.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const managed = task.file.replaceAll("\\", "/") === "待办事项/Northstar.md";
  return <div className={`task-detail-list${items.length > 1 ? " numbered" : ""}`}>{items.map((item, index) => <div className="task-detail-status" key={index}>{task.completed ? <span aria-hidden="true">✓</span> : managed ? <input type="checkbox" aria-label={`完成事项 ${item}`} disabled={updating} checked={task.itemStates?.[index] || false} onChange={event => onToggleItem(task, index, event.target.checked)} /> : null}{items.length > 1 && <span>{index + 1}.</span>}<span>{item}</span></div>)}</div>;
}
function TaskGroup({ title, tasks, loading, onToggle, onToggleItem, updating, onEdit, onDelete }: { title: string; tasks: ObsidianTask[]; loading: boolean; updating: boolean; onToggle: (task: ObsidianTask) => void; onToggleItem: (task: ObsidianTask, item: number, completed: boolean) => void; onEdit: (task: ObsidianTask) => void; onDelete: (task: ObsidianTask) => void }) {
  return <section className="task-group"><h2>{title}{tasks.length > 0 && <small>{tasks.length}</small>}</h2><div className="module-list">{loading ? <div className="task-row">正在读取 Obsidian 待办…</div> : tasks.length === 0 ? <div className="task-row muted">暂无任务</div> : tasks.map(task => <div className={`task-row${task.completed ? " task-completed" : ""}`} key={task.id}>{!task.completed && !task.details && <input aria-label={`完成 ${task.title}`} type="checkbox" disabled={updating} onChange={() => void onToggle(task)} />}<div className="task-row-content"><b>{task.title}{task.reminderAt && <ReminderBadge task={task} />}{task.completed && <span className="task-done-icon" aria-label="已完成">✅</span>}</b>{task.details && <TaskDetails task={task} onToggleItem={onToggleItem} updating={updating} />}<small>{task.reminderAt ? `提醒 · ${task.reminderAt.replace("T", " ")} · ` : ""}{task.file}</small>{task.file.replaceAll("\\", "/") === "待办事项/Northstar.md" && <small>{!task.completed && <><button disabled={updating} onClick={() => onEdit(task)}>编辑</button> · </>}<button disabled={updating} onClick={() => void onDelete(task)}>删除</button></small>}</div></div>)}</div></section>;
}

function localDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function nextMinute() { const next = new Date(); next.setSeconds(0, 0); next.setMinutes(next.getMinutes() + 1); return localDateTime(next); }
function ReminderBadge({task}: {task:ObsidianTask}) {
  const [delivered,setDelivered]=useState(false);
  useEffect(() => { const check=()=> {try { const env=document.querySelector(".development-marker") ? "development" : "production"; const key=`${task.id}|${task.reminderAt}`; const a:unknown=JSON.parse(localStorage.getItem(`northstar.reminders.delivered.v1:${env}`)||"[]"); const b:unknown=JSON.parse(localStorage.getItem(`northstar.reminders.dismissed.v1:${env}`)||"[]"); setDelivered((Array.isArray(a) && a.includes(key)) || (Array.isArray(b) && b.includes(key))); } catch {setDelivered(false);} }; check(); window.addEventListener("northstar-reminders-changed",check); return()=>window.removeEventListener("northstar-reminders-changed",check); },[task.id,task.reminderAt]);
  return <span className={`task-reminder-badge ${delivered ? "delivered" : "pending"}`} title={`提醒时间：${task.reminderAt?.replace("T"," ")} · ${delivered ? "已提醒" : "尚未提醒"}`} aria-label={`提醒时间 ${task.reminderAt?.replace("T"," ")}，${delivered ? "已提醒" : "尚未提醒"}`}><DesignIcon name="bell"/><i aria-hidden="true">{delivered ? "✓" : "?"}</i></span>;
}
function CompactReminder({value, onChange,onValidityChange}: {value:string; onChange:(value:string)=>void;onValidityChange:(valid:boolean)=>void}) {
  const [open,setOpen]=useState(false);const [manual,setManual]=useState(false);const [draft,setDraft]=useState("");const [error,setError]=useState("");const timer=useRef<number | undefined>(undefined); const anchor=useRef<HTMLDivElement>(null); const [position,setPosition]=useState({left:12,top:12});
  const toggle=()=>{if(open){setOpen(false);return;}const rect=anchor.current?.getBoundingClientRect();if(rect){const modal=anchor.current?.closest(".task-edit-dialog")?.getBoundingClientRect();const right=modal ? modal.right+12 : rect.right-280;const left=modal && right+280<=window.innerWidth-12 ? right : Math.min(Math.max(12,right),window.innerWidth-292);const top=Math.max(12,Math.min(rect.bottom+6,window.innerHeight-440));setPosition({left,top});}setOpen(true);};
  useEffect(()=>()=>{if(timer.current)window.clearTimeout(timer.current);},[]);
  const display=value ? `${value.slice(0,4)}年${value.slice(5,7)}月${value.slice(8,10)}日 ${value.slice(11)}:00` : "选择提醒时间";
  const commit=()=> {const match=/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})[ T]+(\d{2}):(\d{2})(?::00)?$/.exec(draft.trim()); if(!match){setError("请输入 YYYY-MM-DD HH:mm");return;} const candidate=`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;const parsed=new Date(candidate);if(Number.isNaN(parsed.getTime()) || localDateTime(parsed)!==candidate || candidate<nextMinute()){setError("请选择有效的未来时间");return;}onChange(candidate);onValidityChange(true);setError("");setManual(false);};
  return <div className="compact-reminder" ref={anchor}>{manual ? <input aria-label="编辑提醒时间" placeholder="YYYY-MM-DD HH:mm" value={draft} onChange={event=>{setDraft(event.target.value);onValidityChange(false);}} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();commit();} if(event.key==="Escape"){setManual(false);setError("");onValidityChange(true);}}} onBlur={commit}/> : <button type="button" aria-label={`提醒时间 ${display}`} aria-expanded={open} onClick={event=>{if(event.detail<=1)timer.current=window.setTimeout(toggle,260);}} onDoubleClick={event=>{event.preventDefault();if(timer.current)window.clearTimeout(timer.current);setOpen(false);setDraft(value.replace("T"," "));setError("");setManual(true);}}>{display}</button>}{error && <small role="alert" className="inline-error">{error}</small>}{open && createPortal(<ReminderPicker value={value} onChange={onChange} onClose={()=>setOpen(false)} position={position}/>,document.querySelector(".app-shell") || document.body)}</div>;
}
function ReminderPicker({value,onChange,onClose,position}:{value:string;onChange:(value:string)=>void;onClose:()=>void;position:{left:number;top:number}}) {
  const initial=value || nextMinute();const [date,setDate]=useState(initial.slice(0,10));const [time,setTime]=useState(initial.slice(11));const [month,setMonth]=useState(initial.slice(0,7));const [error,setError]=useState("");
  const minimum=nextMinute(), minimumDate=minimum.slice(0,10), minMonth=minimumDate.slice(0,7);const [year,monthNumber]=month.split("-").map(Number);const offset=(new Date(year,monthNumber-1,1).getDay()+6)%7;const days=new Date(year,monthNumber,0).getDate();const pad=(n:number)=>String(n).padStart(2,"0");
  const change=(nextDate:string,nextTime:string)=>{const earliest=nextMinute();const candidate=`${nextDate}T${nextTime}` < earliest ? earliest : `${nextDate}T${nextTime}`;setDate(candidate.slice(0,10));setTime(candidate.slice(11));setMonth(candidate.slice(0,7));setError("");};
  const confirm=()=>{const candidate=`${date}T${time}`;if(candidate<nextMinute() || Number.isNaN(new Date(candidate).getTime())){setError("请选择当前时间之后的日期和时间");return;}onChange(candidate);onClose();};
  return <div className="reminder-popover" role="dialog" aria-label="选择提醒日期" style={{left:position.left,top:position.top}}><div className="calendar-heading"><button type="button" aria-label="上个月" disabled={month<=minMonth} onClick={()=>{const d=new Date(year,monthNumber-2,1);setMonth(`${d.getFullYear()}-${pad(d.getMonth()+1)}`);}}>‹</button><b>{year} 年 {monthNumber} 月</b><button type="button" aria-label="下个月" onClick={()=>{const d=new Date(year,monthNumber,1);setMonth(`${d.getFullYear()}-${pad(d.getMonth()+1)}`);}}>›</button></div><div className="calendar-grid">{["一","二","三","四","五","六","日"].map(day=><span className="calendar-weekday" key={day}>{day}</span>)}{Array.from({length:offset},(_,i)=><span key={`empty-${i}`}/>)}{Array.from({length:days},(_,i)=>{const d=`${month}-${pad(i+1)}`;return <button type="button" key={d} aria-label={d} aria-pressed={d===date} disabled={d<minimumDate} onClick={()=>change(d,time)}>{i+1}</button>;})}</div><div className="reminder-time-fields"><label><span className="sr-only">小时</span><select aria-label="小时" value={time.slice(0,2)} onChange={e=>change(date,`${e.target.value}:${time.slice(3)}`)}>{Array.from({length:24},(_,i)=><option key={i} value={pad(i)} disabled={date===minimumDate && i<Number(minimum.slice(11,13))}>{pad(i)}</option>)}</select>时</label><label><span className="sr-only">分钟</span><select aria-label="分钟" value={time.slice(3)} onChange={e=>change(date,`${time.slice(0,2)}:${e.target.value}`)}>{Array.from({length:60},(_,i)=><option key={i} value={pad(i)}>{pad(i)}</option>)}</select>分</label></div>{error && <small role="alert" className="inline-error">{error}</small>}<div className="reminder-popover-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" onClick={confirm}>确定</button></div></div>;
}

function NotesPage({desktop}: {desktop:DesktopContext | null}) {
  const [source,setSource] = useState<"local" | "obsidian">("local");
  return <div className="notes-wrapper"><div className="notes-source" role="tablist" aria-label="笔记来源"><button role="tab" aria-selected={source === "local"} onClick={() => setSource("local")}>工作台笔记</button><button role="tab" aria-selected={source === "obsidian"} onClick={() => setSource("obsidian")}>Obsidian</button></div>{source === "local" ? <LocalNotesPage desktop={desktop}/> : <ObsidianNotesPage desktop={desktop}/>}</div>;
}
function LocalNotesPage({desktop}: {desktop:DesktopContext | null}) {
  const [notes,setNotes]=useState<LocalNote[]>([]); const [folders,setFolders]=useState<string[]>([]); const [folder,setFolder]=useState("*"); const [noteFolder,setNoteFolder]=useState(""); const [query,setQuery]=useState(""); const [folderDialog,setFolderDialog]=useState(false); const [folderName,setFolderName]=useState(""); const [confirmAction,setConfirmAction]=useState<"leave" | "delete" | HTMLElement | null>(null); const allowNavigation=useRef(false); const [selected,setSelected]=useState<LocalNote | null>(null); const [creating,setCreating]=useState(false); const [title,setTitle]=useState(""); const [body,setBody]=useState(""); const [error,setError]=useState(""); const [notice,setNotice]=useState(""); const [busy,setBusy]=useState(false);
  const refresh=async()=> {if (!desktop) return; try {const [n,f]=await Promise.all([desktopApi.listLocalNotes(),desktopApi.listLocalFolders()]);setNotes(n);setFolders(f);} catch(e){setError(String(e));}};
  useEffect(()=>{void refresh();},[desktop]);
  const dirty = creating ? Boolean(title.trim() || body) : Boolean(selected && (title !== selected.title || body !== selected.body || noteFolder !== (selected.folder || "")));
  useEffect(() => { if (!dirty) return; const guard = (event:MouseEvent) => { if(allowNavigation.current){allowNavigation.current=false;return;} const target=(event.target as Element | null)?.closest<HTMLElement>(".sidebar nav button, .notes-source button");if(target){event.preventDefault();event.stopPropagation();setConfirmAction(target);} }; const unload=(event:BeforeUnloadEvent) => {event.preventDefault(); event.returnValue="";}; document.addEventListener("click",guard,true); window.addEventListener("beforeunload",unload); return () => {document.removeEventListener("click",guard,true);window.removeEventListener("beforeunload",unload);}; },[dirty]);
  const closeEditor=()=>{setSelected(null);setCreating(false);setError("");setNotice("");};
  const leave=()=> { if(dirty){setConfirmAction("leave");return;} closeEditor(); };
  const open=(note:LocalNote)=> {setSelected(note);setCreating(false);setTitle(note.title);setBody(note.body);setNoteFolder(note.folder || "");setError("");setNotice("");};
  const save=async()=> {if(busy)return;setBusy(true);setError("");try{const note=await desktopApi.saveLocalNote(selected?.id || null,title,body,selected?.revision ?? null,noteFolder);setSelected(note);setCreating(false);setTitle(note.title);setBody(note.body);setNotice("已保存到工作台");await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const remove=async()=> { if(!selected || busy) return; setBusy(true);setError("");try{await desktopApi.deleteLocalNote(selected.id,selected.revision);setSelected(null);setNotice("已删除工作台笔记");await refresh();}catch(e){setError(String(e));}finally{setBusy(false);} };
  const addFolder=async()=>{if(!folderName.trim() || busy)return;setBusy(true);setError("");try{setFolders(await desktopApi.createLocalFolder(folderName));setFolder(folderName.trim());setFolderName("");setFolderDialog(false);}catch(e){setError(String(e));}finally{setBusy(false);}};
  const syncAll=async()=>{if(busy)return;setBusy(true);setError("");setNotice("");let ok=0;const failed:string[]=[];for(const note of notes){try{await desktopApi.pushLocalNote(note.id,note.revision);ok++;}catch(e){failed.push(`${note.title}：${String(e)}`);}}await refresh();setNotice(`已推送 ${ok} 条${failed.length ? `，${failed.length} 条未完成` : ""}`);if(failed.length)setError(failed.join("；"));setBusy(false);};
  const push=async()=> {if(!selected || dirty || busy)return;setBusy(true);setError("");try{const note=await desktopApi.pushLocalNote(selected.id,selected.revision);setSelected(note);setNotice(note.targetName ? `已推送到 Obsidian：Northstar/${note.targetName}` : "已推送到 Obsidian 的 Northstar 目录");await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="module notes-module local-notes"><div className="notes-fixed"><div className="notes-title"><h1>我的笔记</h1></div>{selected || creating ? <div className="local-note-bar"><button className="back" aria-label="返回列表" onClick={leave}>←</button><button className="primary" disabled={busy || !title.trim()} onClick={() => void save()}>保存</button><button disabled={busy || !selected || dirty} onClick={() => void push()}>推送 Obsidian</button>{selected && <button disabled={busy} onClick={() => setConfirmAction("delete")}>删除</button>}</div> : <div className="notes-controls"><div className="note-actions"><button onClick={()=>setFolderDialog(true)}>新建目录</button><button onClick={() => {setCreating(true);setTitle("");setBody("");setNoteFolder(folder==="*"?"":folder);setNotice("");}}>新建笔记</button><button disabled={busy || !notes.length} onClick={()=>void syncAll()}>{busy ? "同步中…" : "同步 Obsidian"}</button></div><div className="task-create"><select aria-label="笔记目录筛选" value={folder} onChange={e=>setFolder(e.target.value)}><option value="*">全部目录</option><option value="">未分类</option>{folders.map(f=><option key={f} value={f}>{f}</option>)}</select><input aria-label="搜索工作台笔记" placeholder="查询笔记" value={query} onChange={e=>setQuery(e.target.value)}/></div></div>}</div><div className="notes-content"><DesktopRequired desktop={desktop}/>{error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{selected || creating ? <div className="local-note-editor"><select aria-label="笔记目录" value={noteFolder} onChange={e=>setNoteFolder(e.target.value)} disabled={busy}><option value="">未分类</option>{folders.map(f=><option key={f} value={f}>{f}</option>)}</select><input aria-label="笔记标题" disabled={busy} value={title} onChange={e=>setTitle(e.target.value)} placeholder="笔记标题"/><textarea aria-label="笔记正文" disabled={busy} value={body} onChange={e=>setBody(e.target.value)} placeholder="支持 Markdown"/></div> : <div className="module-list note-list">{notes.filter(note=>(folder==="*" || (note.folder||"")===folder) && (!query.trim() || `${note.title}\n${note.body}`.toLowerCase().includes(query.trim().toLowerCase()))).map(note=><button key={note.id} className="note-row" onClick={()=>open(note)}><div><b>{note.title}</b><p>{note.body.slice(0,96) || "空笔记"}</p><small>{note.folder ? `${note.folder} · ` : ""}{note.pushedBody === null ? "尚未推送" : note.pushedBody === `# ${note.title}\n\n${note.body}` ? "上次已推送" : "本地有修改"}</small></div><span>›</span></button>)}</div>}{confirmAction && <div className="dialog-overlay"><section role="alertdialog" aria-modal="true" className="task-confirm-dialog" aria-label={confirmAction === "delete" ? "确认删除" : "未保存的修改"}><h2>{confirmAction === "delete" ? "确认删除" : "未保存的修改"}</h2><p>{confirmAction === "delete" ? "删除工作台笔记？已推送到 Obsidian 的副本会保留。" : "笔记有尚未保存的修改，确定离开？"}</p><div><button className="cancel-delete" onClick={()=>setConfirmAction(null)}>取消</button><button className="confirm-delete" onClick={()=>{const action=confirmAction;setConfirmAction(null);if(action==="delete")void remove();else if(action==="leave")closeEditor();else {allowNavigation.current=true;action.click();}}}>{confirmAction === "delete" ? "删除" : "离开"}</button></div></section></div>}{folderDialog && <div className="dialog-overlay"><section className="task-confirm-dialog" role="dialog" aria-modal="true" aria-label="新建目录"><h2>新建目录</h2><input aria-label="目录名称" value={folderName} onChange={e=>setFolderName(e.target.value)} placeholder="目录名称" />{error && <p role="alert" className="inline-error">{error}</p>}<div><button className="cancel-delete" onClick={()=>{setFolderDialog(false);setError("");}}>取消</button><button className="primary" disabled={busy || !folderName.trim()} onClick={()=>void addFolder()}>创建</button></div></section></div>}</div></section>;
}

const noteSnapshots = new Map<string, ObsidianNote[]>();
function ObsidianNotesPage({ desktop }: { desktop: DesktopContext | null }) {
  const key = desktop?.environment || "browser";
  const [notes, setNotes] = useState<ObsidianNote[]>(() => noteSnapshots.get(key) || []);
  const [query, setQuery] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ObsidianNote | null>(null); const [content, setContent] = useState(""); const [reading, setReading] = useState(false);
  const [dialog,setDialog]=useState<"note"|"folder"|null>(null); const [dialogValue,setDialogValue]=useState(""); const [compact, setCompact] = useState(false); const contentRef = useRef<HTMLDivElement>(null);
  const resetScroll = () => { if (contentRef.current) contentRef.current.scrollTop = 0; setCompact(false); };
  const search = async (value = query) => { if (!desktop) return; setLoading(true); setError(""); try { const result = await desktopApi.listNotes(value); setNotes(result); if (!value.trim()) noteSnapshots.set(key, result); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法查询笔记"); } finally { setLoading(false); } };
  useEffect(() => { setNotes(noteSnapshots.get(key) || []); void search(""); }, [desktop]);
  const openNote = async (note: ObsidianNote) => { resetScroll(); setSelected(note); setContent(""); setReading(true); setError(""); try { setContent(await desktopApi.readNote(note.file)); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取笔记"); } finally { setReading(false); } };
  const createNote = async (title:string) => { if (!title) return; try { const note = await desktopApi.createNote("", title); setNotes(current => { const next = [note, ...current]; if (!query.trim()) noteSnapshots.set(key, next); return next; }); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建笔记"); } };
  const createDirectory = async (path:string) => { if (!path) return; try { await desktopApi.createDirectory(path); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建目录"); } };
  return <section className="module notes-module">
    <div className={`notes-fixed${compact ? " compact" : ""}`}>
      <div className="notes-title"><h1>我的笔记</h1></div>
      {selected ? <button className="back notes-back" aria-label="返回列表" onClick={() => { resetScroll(); setSelected(null); }}>←</button> : desktop && <div className="notes-controls"><div className="note-actions"><button onClick={() => {setDialogValue("");setDialog("folder");}}>新建目录</button><button onClick={() => {setDialogValue("");setDialog("note");}}>新建笔记</button><button onClick={() => { if (desktop.environment === "development") { setError("开发版使用独立测试 Vault，不会打开正式 Obsidian 仓库。"); } else { window.location.href = "obsidian://open?vault=ObsidianVault"; } }}>跳转 Obsidian</button></div><div className="task-create"><input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === "Enter" && void search()} placeholder="查询笔记" /><button className="primary" onClick={() => void search()}>查询笔记</button></div></div>}
    </div>
    <div className="notes-content" ref={contentRef} onScroll={event => setCompact(event.currentTarget.scrollTop > 32)}>
      <DesktopRequired desktop={desktop} />
      {desktop && (selected ? <article className="note-detail"><h2>{selected.title}</h2><small>{selected.file}</small>{reading ? <p>正在读取笔记…</p> : <div className="note-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({children, href}) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{content || "空笔记"}</ReactMarkdown></div>}</article> : <div className="module-list note-list">{loading && notes.length === 0 ? <div className="task-row">正在索引 Vault…</div> : notes.map(note => <button className="note-row" key={note.file} onClick={() => void openNote(note)}><div><b>{note.title}</b><p>{note.preview}</p><small>{note.file}</small></div><span aria-hidden="true">›</span></button>)}</div>)}
      {error && <p className="inline-error">{error}</p>}
      {dialog && <div className="dialog-overlay"><section className="task-confirm-dialog" role="dialog" aria-modal="true" aria-label={dialog === "note" ? "新建笔记" : "新建目录"}><h2>{dialog === "note" ? "新建笔记" : "新建目录"}</h2><input aria-label={dialog === "note" ? "笔记名称" : "目录名称"} value={dialogValue} onChange={event=>setDialogValue(event.target.value)} /><div><button className="cancel-delete" onClick={()=>setDialog(null)}>取消</button><button className="primary" disabled={!dialogValue.trim()} onClick={()=>{const value=dialogValue.trim();const action=dialog;setDialog(null);if(action==="note")void createNote(value);else void createDirectory(value);}}>创建</button></div></section></div>}
    </div>
  </section>;
}

const TRENDING_CACHE_KEY = "northstar.github-trending.v1";
function readTrendingCache(): {items: Repository[]; savedAt: number} | null {
  try {
    const cache = JSON.parse(localStorage.getItem(TRENDING_CACHE_KEY) || "null");
    if (!cache || !Array.isArray(cache.items) || cache.items.length > 10 || !Number.isFinite(cache.savedAt) || cache.savedAt > Date.now() || !cache.items.every((item: Repository) => typeof item.id === "number" && typeof item.full_name === "string" && typeof item.html_url === "string" && /^https:\/\/github\.com\//.test(item.html_url) && typeof item.stargazers_count === "number")) return null;
    return cache;
  } catch { return null; }
}
function isToday(time: number) { return new Date(time).toDateString() === new Date().toDateString(); }
function TrendingPage() {
  const [cached] = useState(readTrendingCache);
  const [repositories, setRepositories] = useState<Repository[]>(cached?.items || []);
  const [resultPage, setResultPage] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(cached ? "ready" : "loading");
  const [updatedAt, setUpdatedAt] = useState(cached ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(cached.savedAt) : "");
  const [refreshError, setRefreshError] = useState("");

  const loadTrending = async () => {
    if (!repositories.length) setStatus("loading");
    setRefreshError("");
    const after = new Date();
    after.setDate(after.getDate() - 30);
    const createdAfter = after.toISOString().slice(0, 10);
    try {
      const response = await fetch(`https://api.github.com/search/repositories?q=created:%3E${createdAfter}&sort=stars&order=desc&per_page=10`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      const payload = await response.json() as { items: Repository[] };
      const savedAt = Date.now();
      setRepositories(payload.items);
      try { localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({items: payload.items, savedAt})); } catch { /* session still works */ }
      setResultPage(0);
      setUpdatedAt(new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(savedAt));
      setStatus("ready");
    } catch {
      if (repositories.length) { setStatus("ready"); setRefreshError("更新失败，正在显示上次的结果。"); } else setStatus("error");
    }
  };

  useEffect(() => { if (!cached || !isToday(cached.savedAt)) void loadTrending(); }, []);

  return <section className="module trending" onScroll={compactModuleHeader}><div className="module-sticky"><span>GitHub 热点</span></div><div className="module-heading"><div><h1>GitHub 热点</h1></div><button className="refresh" onClick={() => void loadTrending()} disabled={status === "loading"}>{status === "loading" ? "加载中…" : "刷新"}</button></div>{refreshError && <p className="inline-error" role="status">{refreshError}</p>}{status === "error" ? <div className="empty-state"><b>暂时无法连接 GitHub</b><p>请检查网络，稍后再次刷新。</p><button className="primary" onClick={() => void loadTrending()}>重试</button></div> : <div className="repository-list" aria-live="polite">{status === "loading" && Array.from({ length: 5 }).map((_, index) => <div className="repository skeleton" key={index}><span></span><div><b></b><p></p></div></div>)}{status === "ready" && repositories.slice(resultPage * 5, resultPage * 5 + 5).map((repository, index) => <article className="repository" key={repository.id}><span className="rank">{resultPage * 5 + index + 1}</span><div><a href={repository.html_url} onClick={event => { if ("__TAURI_INTERNALS__" in window) { event.preventDefault(); void desktopApi.openGithub(repository.html_url).catch(reason => setRefreshError(String(reason))); } }} target="_blank" rel="noreferrer">{repository.full_name}</a><p>{repository.description || "暂无项目描述"}</p><small>{repository.language || "未标记语言"} · ★ {repository.stargazers_count.toLocaleString()}</small></div><a className="repo-open" href={repository.html_url} onClick={event => { if ("__TAURI_INTERNALS__" in window) { event.preventDefault(); void desktopApi.openGithub(repository.html_url).catch(reason => setRefreshError(String(reason))); } }} target="_blank" rel="noreferrer">打开 ↗</a></article>)}{status === "ready" && <div className="pagination"><span>更新于 {updatedAt} · GitHub API</span><button disabled={resultPage === 0} onClick={() => setResultPage(resultPage - 1)}>上一页</button><span>{resultPage + 1} / {Math.max(1, Math.ceil(repositories.length / 5))}</span><button disabled={(resultPage + 1) * 5 >= repositories.length} onClick={() => setResultPage(resultPage + 1)}>下一页</button></div>}</div>}</section>;
}

function ServicesPage({ desktop }: { desktop: DesktopContext | null }) {
  const [services, setServices] = useState<ServiceStatus[]>(() => serviceSnapshot?.items || []);
  const [compact, setCompact] = useState(false);
  const [loading, setLoading] = useState(Boolean(desktop) && !serviceSnapshot);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [serviceName, setServiceName] = useState(""); const [serviceTarget, setServiceTarget] = useState(""); const [serviceKind, setServiceKind] = useState<CustomService["kind"]>("http"); const [adding, setAdding] = useState(false);
  const load = async (force=false) => {
    if (!desktop) return;
    setLoading(true); setError("");
    try { const snapshot=await loadServiceSnapshot(force); setServices(snapshot.items); setUpdatedAt(new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(snapshot.fetchedAt))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取服务状态"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [desktop]);
  const addService = async () => { if (!serviceName.trim() || !serviceTarget.trim()) return; setAdding(true); setError(""); try { await desktopApi.registerCustomService(serviceName, serviceTarget, serviceKind); setServiceName(""); setServiceTarget(""); await load(true); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法登记自定义服务"); } finally { setAdding(false); } };
  const removeService = async (id: string) => { try { await desktopApi.removeCustomService(id); await load(true); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法移除自定义服务"); } };
  return <section className="module services services-layout"><div className={`services-fixed${compact ? " compact" : ""}`}><div className="module-heading"><div><h1>我的服务</h1></div><button className="refresh" onClick={() => void load(true)} disabled={loading}>{loading ? "探测中…" : "刷新"}</button></div></div><div className="services-content" onScroll={event => setCompact(event.currentTarget.scrollTop > 32)}><DesktopRequired desktop={desktop} />{desktop && <><section className="service-setup"><h2>挂载服务</h2><div className="service-fields"><input value={serviceName} onChange={event => setServiceName(event.target.value)} placeholder="名称，例如：代理订阅" /><select value={serviceKind} onChange={event => setServiceKind(event.target.value as CustomService["kind"])}><option value="http">HTTP(S)</option><option value="tcp">TCP 端口</option></select><input value={serviceTarget} onChange={event => setServiceTarget(event.target.value)} onKeyDown={event => event.key === "Enter" && void addService()} placeholder={serviceKind === "http" ? "https://status.example.com/health" : "host.example.com:443"} /><button className="primary" disabled={adding} onClick={() => void addService()}>{adding ? "保存中…" : "挂载"}</button></div><p>HTTP(S) 以 2xx / 3xx 视为可用；TCP 使用主机:端口进行连接测试。</p></section>{error && <p className="inline-error">{error}</p>}<div className="service-list">{services.map(service => <article className="service-card" key={service.id}><div className="service-card-head"><span className={service.reachable ? "status" : "status warn"}></span><div><h2>{service.name}</h2><p>{service.description}</p></div><small>{service.reachable ? `${service.latencyMs ?? "—"} ms` : "不可达"}</small></div>{service.reachable ? <>{service.id.startsWith("custom-") ? <p className="service-custom-target">{service.hostname}</p> : <div className="service-metrics"><span><b>{service.hostname}</b>主机</span><span><b>{service.uptime}</b>在线时长</span><span><b>{service.load}</b>负载</span><span><b>{service.memory}</b>内存</span><span><b>{service.disk}</b>系统盘</span></div>}<div className="service-checks">{service.checks.map(check => <span key={check.name} className={check.healthy ? "healthy" : "warning"}>● {check.name} · {check.state}</span>)}</div></> : <p className="inline-error">{service.error || "探测失败"}</p>}{service.id.startsWith("custom-") && <button className="service-remove" onClick={() => void removeService(service.id)}>移除挂载</button>}</article>)}{!loading && services.length === 0 && !error && <div className="empty-state"><b>尚未发现服务</b><p>可在 DSH 中添加 SSH 主机，或手动挂载 HTTP / TCP 服务。</p></div>}</div>{updatedAt && <p className="updated service-updated">最近探测：{updatedAt}</p>}</>}</div></section>;
}

type AgentId = "dsh" | "codex" | "pi";
type AgentMessage = { role: "user" | "assistant"; content: string };
const agentHistory: Record<AgentId, AgentMessage[]> = { dsh: [], codex: [], pi: [] };
function PageContent({ desktop }: { desktop: DesktopContext | null }) {
  const [agent, setAgent] = useState<AgentId>("dsh"); const [histories, setHistories] = useState<Record<AgentId, AgentMessage[]>>(() => ({...agentHistory}));
  const [input, setInput] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [preview, setPreview] = useState(false);
  const request = useRef<string | null>(null); const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; if (request.current) void desktopApi.cancelAgentChat(request.current).catch(() => undefined); }; }, []);
  const tabs: {id:AgentId; label:string}[] = [{id:"dsh",label:"DSH"},{id:"codex",label:"Codex"},{id:"pi",label:"Pi"}];
  const installed = (id: AgentId) => desktop?.agents.some(item => item.name.toLowerCase() === id && item.installed) || false;
  const save = (id: AgentId, next: AgentMessage[]) => { agentHistory[id] = next; if (active.current) setHistories(current => ({...current,[id]:next})); };
  const send = async () => {
    const text = input.trim(); if (!text || busy || !desktop) return;
    if (text.length > 4000) { setError("单条消息请控制在 4000 字以内。"); return; }
    if (!installed(agent)) { setError("未发现该 Agent，请先安装或检查本机配置。"); return; }
    const id = agent; const messages: AgentMessage[] = [...agentHistory[id], {role:"user",content:text}]; save(id, messages); setInput(""); setError(""); setBusy(true);
    const requestId = crypto.randomUUID(); request.current = requestId;
    const recent = messages.slice(-12); const prompt = recent.map((message, index) => `${message.role === "user" ? "用户" : "助手"}: ${index === recent.length - 1 ? message.content : message.content.slice(0, 1200)}`).join("\n\n");
    try { const answer = await desktopApi.agentChat(id, requestId, prompt); save(id, [...messages, {role:"assistant",content:answer}]); }
    catch (reason) { if (active.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request.current === requestId) request.current = null; if (active.current) setBusy(false); }
  };
  const latest = [...histories[agent]].reverse().find(message => message.role === "assistant")?.content;
  return <section className="module agent-workspace"><div className="agent-fixed"><h1>我的 Agent</h1><div className="mail-provider-tabs agent-tabs" role="tablist" aria-label="选择 Agent">{tabs.map(item => <button role="tab" key={item.id} aria-selected={agent === item.id} className={agent === item.id ? "active" : ""} onClick={() => { setAgent(item.id); setError(""); }}><span className={`agent-tab-icon ${item.id}`}>{item.label.slice(0,1)}</span><span>{item.label}</span><small>{installed(item.id) ? "已发现" : "未安装"}</small></button>)}</div></div><div className="agent-main"><div className="agent-conversation"><div className="agent-messages" aria-live="polite">{!histories[agent].length && <div className="agent-empty"><b>与 {tabs.find(item => item.id === agent)?.label} 开始对话</b><p>消息由本机 Agent 处理，对话保留在本次运行中。</p></div>}{histories[agent].map((message, index) => <article key={index} className={`agent-message ${message.role}`}><span>{message.role === "user" ? "你" : tabs.find(item => item.id === agent)?.label}</span><div className="agent-message-text"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:() => null}}>{message.content}</ReactMarkdown></div></article>)}{busy && request.current && <p className="agent-running">正在等待 Agent 回复…</p>}{error && <p className="inline-error" role="alert">{error}</p>}</div><div className="agent-composer"><textarea aria-label="给 Agent 发送消息" value={input} disabled={!desktop || !installed(agent)} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} placeholder={installed(agent) ? "输入消息，Enter 发送 · Shift + Enter 换行" : "未发现该 Agent"}/><div><button onClick={() => setPreview(value => !value)}>{preview ? "收起预览" : "打开预览"}</button>{busy ? <button onClick={() => { if (request.current) void desktopApi.cancelAgentChat(request.current).catch(reason => setError(String(reason))); }}>停止</button> : <button className="primary" disabled={!input.trim() || !desktop || !installed(agent)} onClick={() => void send()}>发送</button>}</div></div></div>{preview && <aside className="agent-preview"><div><b>预览</b><button onClick={() => setPreview(false)} aria-label="关闭预览">×</button></div>{latest ? <div className="note-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:() => null}}>{latest}</ReactMarkdown></div> : <p>回复后可在这里预览内容</p>}</aside>}</div></section>;
}
