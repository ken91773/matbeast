"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import packageJson from "../../package.json";

type Tab = {
  href: string;
  label: string;
};

const TABS: Tab[] = [
  { href: "/", label: "Home" },
  { href: "/roster", label: "Roster Hub" },
  { href: "/roster/blue-belt", label: "Blue Belt" },
  { href: "/roster/purple-brown", label: "Purple/Brown" },
  { href: "/control", label: "Control" },
  { href: "/overlay", label: "Overlay" },
];
const APP_VERSION = packageJson.version;

export default function DesktopTabMenu() {
  const pathname = usePathname();
  const desktopApi = typeof window !== "undefined" ? window.matBeastDesktop : undefined;
  const [runtimeInfo, setRuntimeInfo] = useState<{
    version: string;
    executablePath: string;
    isPackaged: boolean;
  } | null>(null);

  useEffect(() => {
    if (!desktopApi?.getRuntimeInfo) {
      return;
    }
    let mounted = true;
    void desktopApi.getRuntimeInfo().then((info) => {
      if (mounted) {
        setRuntimeInfo(info);
      }
    });
    return () => {
      mounted = false;
    };
  }, [desktopApi]);

  if (pathname === "/overlay") {
    return null;
  }

  return (
    <div className="border-b border-zinc-700 bg-zinc-900">
      <nav aria-label="Main navigation tabs" className="mx-auto flex w-full max-w-7xl items-end justify-between px-3 pt-2">
        <div className="flex">
        {TABS.map((tab) => {
          const isActive = pathname === tab.href || (tab.href !== "/" && pathname.startsWith(tab.href));
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={[
                "mr-1 rounded-t-md border border-b-0 px-3 py-2 text-sm font-semibold transition-colors",
                isActive
                  ? "border-zinc-600 bg-zinc-800 text-white"
                  : "border-transparent bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800 hover:text-white",
              ].join(" ")}
            >
              {tab.label}
            </Link>
          );
        })}
        </div>
        <div className="mb-2 flex items-center gap-3">
          <button
            type="button"
            className="rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-[11px] font-semibold tracking-wide text-zinc-200 hover:bg-zinc-700"
            onClick={async () => {
              if (!desktopApi?.checkForUpdatesWithDebug || !desktopApi?.showUpdateDebugDialog) {
                return;
              }
              const result = await desktopApi.checkForUpdatesWithDebug();
              const lines = result.logs ?? ["No debug logs returned."];
              await desktopApi.showUpdateDebugDialog(lines);
            }}
          >
            UPDATES DEBUG
          </button>
          <div className="text-xs font-semibold tracking-wide text-zinc-400">VERSION {APP_VERSION}</div>
        </div>
      </nav>
      {runtimeInfo ? (
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between border-t border-zinc-800 px-3 py-1 text-[11px] text-zinc-400">
          <div title={runtimeInfo.executablePath} className="truncate">
            EXE: {runtimeInfo.executablePath}
          </div>
          <div className="ml-4 whitespace-nowrap">
            RUNTIME v{runtimeInfo.version} {runtimeInfo.isPackaged ? "(INSTALLED)" : "(DEV)"}
          </div>
        </div>
      ) : null}
    </div>
  );
}
