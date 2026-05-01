"use client";

import AppChrome from "@/components/AppChrome";
import CloudEventDialogs from "@/components/CloudEventDialogs";
import FirstLaunchPasswordGate from "@/components/FirstLaunchPasswordGate";
import { MatBeastFocusAndInputBridge } from "@/components/MatBeastFocusAndInputBridge";
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

  /**
   * v1.1.1 — gate the entire dashboard tree behind a first-launch
   * password. While the gate is active none of the bridges, chrome,
   * or page content is mounted; once unlocked the dashboard renders
   * exactly as before. Overlay routes (handled above) are never
   * gated so popped-out / NDI offscreen windows always work.
   */
  return (
    <FirstLaunchPasswordGate>
      <div className="flex h-full min-h-0 flex-col">
        <MatBeastFocusAndInputBridge />
        <NativeFileMenuBridge />
        <QuitSaveBridge />
        <AppChrome />
        <CloudEventDialogs />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </FirstLaunchPasswordGate>
  );
}
