export type DesktopContext = {
  environment: "development" | "production";
  vaultPath: string;
  taskDirectory: string;
  agents: Array<{ name: string; installed: boolean; path?: string }>;
};

export type ObsidianTask = { id: string; title: string; details: string; itemStates?: boolean[]; raw: string; completed: boolean; reminderAt?: string; file: string; line: number };
export type LocalNote = { id:string; title:string; body:string; revision:number; pushedBody:string | null; targetName?:string | null; folder?:string };
export type ObsidianNote = { file: string; title: string; preview: string };
export type ServiceStatus = {
  id: string; name: string; description: string; reachable: boolean; latencyMs?: number;
  hostname?: string; uptime?: string; load?: string; memory?: string; disk?: string;
  checks: Array<{ name: string; state: string; healthy: boolean }>; error?: string;
};
export type MailAccount = { id: string; provider: "gmail" | "outlook" | "qq" | "imap"; address: string; label: string; authType: "oauth" | "app_password"; connectionState: "setup_required" | "connected" | "error" };
export type GmailSetup = { configured: boolean; clientIdHint?: string; clientSecretConfigured: boolean };
export type MailMessage = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string; labels: string[]; body?: string | null; htmlBody?: string | null };
export type MailCategory = "inbox" | "all" | "unread" | "read" | "spam";
export type MailSyncResult = { order: string[]; unread: string[]; newMessages: MailMessage[] };
export type SidebarCounts = { openTasks: number; unreadMail: number };
export type CustomService = { id: string; name: string; target: string; kind: "http" | "tcp" };

export function isDesktopApp() {
  return "__TAURI_INTERNALS__" in window;
}

export async function getDesktopContext(): Promise<DesktopContext | null> {
  if (!isDesktopApp()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopContext>("get_desktop_context");
}

async function invoke<T>(command: string, args?: Record<string, unknown>) {
  if (!isDesktopApp()) throw new Error("请在 Northstar Windows 应用中使用本机功能");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

const pendingReads = new Map<string, Promise<unknown>>();
function readOnce<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const key = JSON.stringify([command, args]);
  const existing = pendingReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const request = invoke<T>(command, args).finally(() => pendingReads.delete(key));
  pendingReads.set(key, request);
  return request;
}

export const desktopApi = {
  uiUpdateReady: () => invoke<number>("ui_update_ready"),
  checkUiUpdate: () => invoke<{revision: number} | null>("check_ui_update"),
  applyUiUpdate: () => invoke<void>("apply_ui_update"),
  listTasks: () => invoke<ObsidianTask[]>("list_obsidian_tasks"),
  setTaskItem: (task: ObsidianTask, item: number, completed: boolean) => invoke<void>("set_northstar_task_item", { line: task.line, expected: task.raw, item, completed }),
  createTask: (title: string, details: string, reminderAt?: string) => invoke<ObsidianTask>("create_obsidian_task", { title, details, reminderAt }),
  changeTask: (task: ObsidianTask, title?: string, details?: string, reminderAt?: string) => invoke<void>("change_northstar_task", { line: task.line, expected: task.raw, title, details, reminderAt }),
  setTaskCompletion: (file: string, line: number, completed: boolean) => invoke<void>("set_obsidian_task_completion", { file, line, completed }),
  listLocalFolders: () => invoke<string[]>("list_local_folders"),
  createLocalFolder: (name:string) => invoke<string[]>("create_local_folder", {name}),
  listLocalNotes: () => invoke<LocalNote[]>("list_local_notes"),
  saveLocalNote: (id:string | null, title:string, body:string, expectedRevision:number | null, folder?:string) => invoke<LocalNote>("save_local_note", {id, title, body, expectedRevision, folder}),
  deleteLocalNote: (id:string, expectedRevision:number) => invoke<void>("delete_local_note", {id, expectedRevision}),
  pushLocalNote: (id:string, expectedRevision:number) => invoke<LocalNote>("push_local_note", {id, expectedRevision}),
  listNotes: (query: string) => readOnce<ObsidianNote[]>("list_obsidian_notes", { query }),
  readNote: (file: string) => invoke<string>("read_obsidian_note", { file }),
  createNote: (directory: string, title: string) => invoke<ObsidianNote>("create_obsidian_note", { directory, title }),
  createDirectory: (path: string) => invoke<void>("create_obsidian_directory", { path }),
  agentChat: (agent: string, requestId: string, prompt: string) => invoke<string>("agent_chat", {agent, requestId, prompt}),
  cancelAgentChat: (requestId: string) => invoke<void>("cancel_agent_chat", {requestId}),
  listServices: () => readOnce<ServiceStatus[]>("list_services"),
  getSidebarCounts: () => readOnce<SidebarCounts>("get_sidebar_counts"),
  registerCustomService: (name: string, target: string, kind: CustomService["kind"]) => invoke<CustomService>("register_custom_service", { name, target, kind }),
  removeCustomService: (id: string) => invoke<void>("remove_custom_service", { id }),
  listMailAccounts: () => invoke<MailAccount[]>("list_mail_accounts"),
  registerMailAccount: (provider: MailAccount["provider"], address: string, label: string) => invoke<MailAccount>("register_mail_account", { provider, address, label }),
  getGmailSetup: () => invoke<GmailSetup>("get_gmail_setup"),
  setGmailClientId: (clientId: string) => invoke<GmailSetup>("set_gmail_client_id", { clientId }),
  setGmailClientSecret: (clientSecret: string) => invoke<GmailSetup>("set_gmail_client_secret", { clientSecret }),
  connectGmail: () => invoke<MailAccount>("connect_gmail"),
  connectGmailImap: (address: string, password: string) => invoke<MailAccount>("connect_gmail_imap", { address, password }),
  openGithub: (url: string) => invoke<void>("open_github_url", { url }),
  openGmailAppPasswords: () => invoke<void>("open_gmail_app_passwords"),
  cancelGmailAuth: () => invoke<void>("cancel_gmail_auth"),
  listMailMessages: (accountId: string, category: MailCategory = "inbox") => invoke<MailMessage[]>("list_mail_messages", { accountId, category }),
  listOlderMail: (accountId: string, category: MailCategory, before: string) => invoke<MailMessage[]>("list_older_mail", { accountId, category, before }),
  syncMailMessages: (accountId: string, category: MailCategory, knownIds: string[]) => invoke<MailSyncResult>("sync_mail_messages", { accountId, category, knownIds }),
  batchMailAction: (accountId: string, messageIds: string[], category: MailCategory, action: "read" | "trash" | "spam") => invoke<{succeeded: string[]; failed: {id: string; error: string}[]}>("batch_mail_action", {accountId, messageIds, category, action}),
  markMailRead: (accountId: string, messageId: string, category: MailCategory) => invoke<void>("mark_mail_read", { accountId, messageId, category }),
  getMailMessage: (accountId: string, messageId: string, category: MailCategory = "inbox") => invoke<MailMessage>("get_mail_message", { accountId, messageId, category }),
};
