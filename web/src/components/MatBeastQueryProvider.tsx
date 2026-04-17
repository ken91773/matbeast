"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Local-first defaults: same-origin API only, no auth, no reliance on WAN.
 * Retries and refetch-on-focus would add noise when the bundled server is down.
 */
export function MatBeastQueryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 0,
            gcTime: 10 * 60_000,
            retry: 0,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            /** Required for match clock + timer sounds while the window is in the background. */
            refetchIntervalInBackground: true,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
