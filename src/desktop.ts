export type DesktopContext = {
  vaultPath: string;
  taskDirectory: string;
  agents: Array<{ name: string; installed: boolean; path?: string }>;
};

export type ObsidianTask = { id: string; title: string; details: string; raw: string; completed: boolean; reminderAt?: string; file: string; line: number };
export type ObsidianNote = { file: string; title: string; preview: string };
export type ServiceStatus = {
  id: string; name: string; description: string; reachable: boolean; latencyMs?: number;
  hostname?: string; uptime?: string; load?: string; memory?: string; disk?: string;
  checks: Array<{ name: string; state: string; healthy: boolean }>; error?: string;
};
export type MailAccount = { id: string; provider: "gmail" | "outlook" | "qq" | "imap"; address: string; label: string; authType: "oauth" | "app_password"; connectionState: "setup_required" | "connected" | "error" };
export type GmailSetup = { configured: boolean; clientIdHint?: string };
export type MailMessage = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string; labels: string[]; body?: string };
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
  listTasks: () => readOnce<ObsidianTask[]>("list_obsidian_tasks"),
  createTask: (title: string, details: string, reminderAt?: string) => invoke<ObsidianTask>("create_obsidian_task", { title, details, reminderAt }),
  changeTask: (task: ObsidianTask, title?: string, details?: string, reminderAt?: string) => invoke<void>("change_northstar_task", { line: task.line, expected: task.raw, title, details, reminderAt }),
  setTaskCompletion: (file: string, line: number, completed: boolean) => invoke<void>("set_obsidian_task_completion", { file, line, completed }),
  listNotes: (query: string) => readOnce<ObsidianNote[]>("list_obsidian_notes", { query }),
  createNote: (directory: string, title: string) => invoke<ObsidianNote>("create_obsidian_note", { directory, title }),
  createDirectory: (path: string) => invoke<void>("create_obsidian_directory", { path }),
  listServices: () => readOnce<ServiceStatus[]>("list_services"),
  getSidebarCounts: () => readOnce<SidebarCounts>("get_sidebar_counts"),
  registerCustomService: (name: string, target: string, kind: CustomService["kind"]) => invoke<CustomService>("register_custom_service", { name, target, kind }),
  removeCustomService: (id: string) => invoke<void>("remove_custom_service", { id }),
  listMailAccounts: () => invoke<MailAccount[]>("list_mail_accounts"),
  registerMailAccount: (provider: MailAccount["provider"], address: string, label: string) => invoke<MailAccount>("register_mail_account", { provider, address, label }),
  getGmailSetup: () => invoke<GmailSetup>("get_gmail_setup"),
  setGmailClientId: (clientId: string) => invoke<GmailSetup>("set_gmail_client_id", { clientId }),
  connectGmail: () => invoke<MailAccount>("connect_gmail"),
  listMailMessages: (accountId: string) => invoke<MailMessage[]>("list_mail_messages", { accountId }),
  getMailMessage: (accountId: string, messageId: string) => invoke<MailMessage>("get_mail_message", { accountId, messageId }),
};
