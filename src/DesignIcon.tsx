import type { ReactNode, SVGProps } from "react";

export type DesignIconName = "home" | "tasks" | "trending" | "agents" | "notes" | "inbox" | "services" | "star" | "minimize" | "maximize" | "close" | "bell" | "sun" | "moon" | "refresh" | "back";

const paths: Record<DesignIconName, ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5M9.5 21v-6h5v6"/></>,
  tasks: <path d="m4.5 12 5 5 10-11"/>,
  trending: <><path d="m3 17 6-6 4 3 7-8"/><path d="M16 6h4v4"/></>,
  agents: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></>,
  notes: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h5"/></>,
  inbox: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  services: <><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5"/></>,
  star: <path d="m12 3 1.9 7.1L21 12l-7.1 1.9L12 21l-1.9-7.1L3 12l7.1-1.9L12 3Z"/>,
  minimize: <path d="M5 12h14"/>, maximize: <rect x="5" y="5" width="14" height="14" rx="1"/>, close: <path d="M6 6l12 12M18 6 6 18"/>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-2 7-2 9h16c0-2-2-2-2-9"/><path d="M10 20h4"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></>,
  moon: <path d="M20 15.7A8 8 0 0 1 8.3 4a8 8 0 1 0 11.7 11.7Z"/>,
  refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-1.3 4"/></>,
  back: <><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></>,
};

export function DesignIcon({ name, ...props }: { name: DesignIconName } & SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
