"use client";

import AppChrome from "@/components/AppChrome";
import { NativeFileMenuBridge } from "@/components/NativeFileMenuBridge";
import { QuitSaveBridge } from "@/components/QuitSaveBridge";
import { usePathname } from "next/navigation";

export default function RouteChromeShell({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();
  const isOverlayRoute = pathname?.startsWith("/overlay") ?? false;

  if (isOverlayRoute) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <NativeFileMenuBridge />
      <QuitSaveBridge />
      <AppChrome />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
