"use client";

import AppChrome from "@/components/AppChrome";
import CloudEventDialogs from "@/components/CloudEventDialogs";
import FirstLaunchPasswordGate from "@/components/FirstLaunchPasswordGate";
import MandatoryUpdateGate from "@/components/MandatoryUpdateGate";
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
   *
   * v1.2.10 — wraps in `MandatoryUpdateGate` so once Electron's
   * `autoUpdater` reports a newer release the dashboard is blocked
   * by a full-screen overlay that only resolves when the user
   * installs the update (which restarts the app on the new version).
   * The mandatory gate sits OUTSIDE the password gate so an
   * out-of-date install can't even reach the password prompt.
   */
  return (
    <MandatoryUpdateGate>
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
    </MandatoryUpdateGate>
  );
}
