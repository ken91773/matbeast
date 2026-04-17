"use client";

import {
  getMatBeastTournamentId,
  setMatBeastTournamentId,
} from "@/lib/matbeast-fetch";
import { matbeastDebugLog } from "@/lib/matbeast-debug-log";
import { matbeastKeys } from "@/lib/matbeast-query-keys";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const TABS_STORAGE_KEY = "matbeast-open-tabs-v1";
/** Must match `STORAGE_KEY` in `@/lib/matbeast-fetch` (localStorage sync across windows). */
const ACTIVE_TOURNAMENT_STORAGE_KEY = "matbeast-active-tournament-id";

export type EventTab = { id: string; name: string };

type TournamentSummary = {
  id: string;
  name: string;
  updatedAt: string;
};

type Ctx = {
  tournamentId: string | null;
  tournamentName: string;
  openTabs: EventTab[];
  ready: boolean;
  tournaments: TournamentSummary[];
  refreshTournaments: () => Promise<void>;
  openEventInTab: (id: string, name: string) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  renameActiveTab: (name: string) => void;
  updateTabName: (id: string, name: string) => void;
  selectTournament: (id: string, name: string) => void;
  setActiveTournament: (id: string, name: string) => void;
};

const EventWorkspaceContext = createContext<Ctx | null>(null);

export function useEventWorkspace() {
  const v = useContext(EventWorkspaceContext);
  if (!v) {
    throw new Error("useEventWorkspace must be used within EventWorkspaceProvider");
  }
  return v;
}

function readStoredTabs(): EventTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    return p
      .filter(
        (x): x is EventTab =>
          Boolean(x) &&
          typeof x === "object" &&
          typeof (x as EventTab).id === "string" &&
          typeof (x as EventTab).name === "string",
      )
      .map((x) => ({ id: x.id, name: x.name }));
  } catch {
    return [];
  }
}

async function fetchTournaments(): Promise<TournamentSummary[]> {
  const res = await fetch("/api/tournaments", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET /api/tournaments ${res.status}`);
  }
  const j = (await res.json()) as { tournaments?: TournamentSummary[] };
  return j.tournaments ?? [];
}

export function EventWorkspaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [openTabs, setOpenTabs] = useState<EventTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const orphanRecoveryRef = useRef(false);
  const openTabsRef = useRef<EventTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);

  const {
    data: tournaments = [],
    isFetched: tournamentsFetched,
    isError: tournamentsError,
    isFetching: tournamentsFetching,
  } = useQuery({
    queryKey: matbeastKeys.tournaments(),
    queryFn: fetchTournaments,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  /** Overlay / second Electron window: follow active event when main window updates localStorage. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.newValue) return;
      if (e.key !== ACTIVE_TOURNAMENT_STORAGE_KEY) return;
      const nextId = e.newValue;
      if (!nextId || nextId === activeTabIdRef.current) return;
      activeTabIdRef.current = nextId;
      setActiveTabId(nextId);
      setMatBeastTournamentId(nextId);
      void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [queryClient]);

  const tournamentId = activeTabId;
  const tournamentName =
    openTabs.find((t) => t.id === activeTabId)?.name ?? "Untitled event";

  useEffect(() => {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/overlay")) {
      void window.matBeastDesktop?.setOverlayTournamentId?.(tournamentId ?? null);
    }
  }, [tournamentId]);

  useEffect(() => {
    if (tournaments.length > 0) orphanRecoveryRef.current = false;
  }, [tournaments.length]);

  const persistTabsToStorage = useCallback((tabs: EventTab[], activeId: string | null) => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
      setMatBeastTournamentId(activeId);
    } catch {
      /* ignore */
    }
  }, []);

  const invalidateAndBroadcast = useCallback(
    (id: string) => {
      setMatBeastTournamentId(id);
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/overlay")) {
        void window.matBeastDesktop?.setOverlayTournamentId?.(id);
      }
      void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
      window.dispatchEvent(
        new CustomEvent("matbeast-tournament-changed", { detail: { id } }),
      );
    },
    [queryClient],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        let serverList: TournamentSummary[] = [];
        let serverListOk = false;
        try {
          serverList = await fetchTournaments();
          serverListOk = true;
        } catch {
          serverList = [];
          serverListOk = false;
        }
        if (cancelled) return;

        /**
         * When the list request fails (server still booting, overlay opened first, etc.),
         * `serverList` is empty but that does **not** mean there are no tournaments — do not
         * require `validIds.has(id)` or we strip all tabs and clear `activeTabId`, so board
         * / bracket overlay never fetch.
         */
        if (!serverListOk) {
          let tabs = readStoredTabs();
          if (tabs.length === 0) {
            const storedSingle = getMatBeastTournamentId();
            if (storedSingle) {
              tabs = [{ id: storedSingle, name: "Untitled event" }];
            }
          }
          let active = getMatBeastTournamentId();
          if (!active || !tabs.some((t) => t.id === active)) {
            active = tabs[0]?.id ?? null;
          }
          openTabsRef.current = tabs;
          setOpenTabs(tabs);
          setActiveTabId(active);
          setMatBeastTournamentId(active);
          persistTabsToStorage(tabs, active);
          return;
        }

        const validIds = new Set(serverList.map((t) => t.id));
        let tabs: EventTab[] = [];

        tabs = readStoredTabs().filter((t) => validIds.has(t.id));
        tabs = tabs.map((t) => {
          const s = serverList.find((x) => x.id === t.id);
          return { id: t.id, name: s?.name ?? t.name };
        });

        if (tabs.length === 0) {
          const storedSingle = getMatBeastTournamentId();
          if (storedSingle && validIds.has(storedSingle)) {
            const s = serverList.find((x) => x.id === storedSingle);
            tabs = [{ id: storedSingle, name: s?.name ?? "Untitled event" }];
          }
        }

        if (cancelled) return;

        let active = getMatBeastTournamentId();
        if (!active || !tabs.some((t) => t.id === active)) {
          active = tabs[0]?.id ?? null;
        }

        openTabsRef.current = tabs;
        setOpenTabs(tabs);
        setActiveTabId(active);
        setMatBeastTournamentId(active);
        persistTabsToStorage(tabs, active);
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [queryClient, persistTabsToStorage]);

  useEffect(() => {
    if (!ready) return;
    persistTabsToStorage(openTabs, activeTabId);
  }, [openTabs, activeTabId, ready, persistTabsToStorage]);

  useEffect(() => {
    if (tournaments.length === 0) return;
    setOpenTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const s = tournaments.find((t) => t.id === tab.id);
        if (s && s.name !== tab.name) {
          changed = true;
          return { ...tab, name: s.name };
        }
        return tab;
      });
      return changed ? next : prev;
    });
  }, [tournaments]);

  useEffect(() => {
    if (!ready || !tournamentsFetched || tournamentsError || !activeTabId) {
      return;
    }

    if (tournaments.length > 0) {
      const existsOnServer = tournaments.some((t) => t.id === activeTabId);
      const tabIds = openTabsRef.current.map((t) => t.id);
      if (!existsOnServer) {
        if (tournamentsFetching) {
          matbeastDebugLog("tabs:sync", "defer prune (fetching)", {
            activeTabId,
            tabIds,
            tournamentCount: tournaments.length,
          });
          return;
        }
        matbeastDebugLog("tabs:sync", "prune missing on server", {
          activeTabId,
          tabIds,
          tournamentIds: tournaments.map((t) => t.id),
        });
        const prev = openTabsRef.current;
        const next = prev.filter((t) => t.id !== activeTabId);
        if (next.length === 0) {
          openTabsRef.current = [];
          setOpenTabs([]);
          setActiveTabId(null);
          setMatBeastTournamentId(null);
          persistTabsToStorage([], null);
          void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
        } else {
          const idx = prev.findIndex((t) => t.id === activeTabId);
          const pick = next[Math.max(0, idx - 1)] ?? next[0];
          openTabsRef.current = next;
          setOpenTabs(next);
          setActiveTabId(pick.id);
          invalidateAndBroadcast(pick.id);
        }
      }
      return;
    }

    if (tournamentsFetching) {
      matbeastDebugLog("tabs:sync", "defer orphan (fetching)", { activeTabId });
      return;
    }

    if (orphanRecoveryRef.current) return;
    matbeastDebugLog("tabs:sync", "orphan recovery: clear tabs (use File → New Event)", {
      activeTabId,
    });
    orphanRecoveryRef.current = true;
    openTabsRef.current = [];
    setOpenTabs([]);
    setActiveTabId(null);
    setMatBeastTournamentId(null);
    persistTabsToStorage([], null);
    void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
    orphanRecoveryRef.current = false;
  }, [
    activeTabId,
    tournaments,
    tournamentsFetched,
    tournamentsError,
    tournamentsFetching,
    ready,
    queryClient,
    invalidateAndBroadcast,
    persistTabsToStorage,
  ]);

  const refreshTournaments = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: matbeastKeys.tournaments() });
  }, [queryClient]);

  const selectTab = useCallback(
    (id: string) => {
      if (!openTabsRef.current.some((t) => t.id === id)) return;
      setActiveTabId(id);
      invalidateAndBroadcast(id);
    },
    [invalidateAndBroadcast],
  );

  const openEventInTab = useCallback(
    (id: string, name: string) => {
      const prev = openTabsRef.current;
      const next = prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, name }];
      matbeastDebugLog("tabs:open", id, name, {
        wasNew: !prev.some((t) => t.id === id),
        nextCount: next.length,
        prevIds: prev.map((t) => t.id),
      });
      openTabsRef.current = next;
      setOpenTabs(next);
      setActiveTabId(id);
      invalidateAndBroadcast(id);
      persistTabsToStorage(next, id);
    },
    [invalidateAndBroadcast, persistTabsToStorage],
  );

  const closeTab = useCallback(
    (id: string) => {
      const prev = openTabsRef.current;
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const next = prev.filter((t) => t.id !== id);

      if (next.length === 0) {
        openTabsRef.current = [];
        setOpenTabs([]);
        setActiveTabId(null);
        setMatBeastTournamentId(null);
        persistTabsToStorage([], null);
        void queryClient.invalidateQueries({ queryKey: matbeastKeys.all });
        return;
      }

      openTabsRef.current = next;
      setOpenTabs(next);
      if (activeTabId === id) {
        const neighbor = next[Math.max(0, idx - 1)] ?? next[0]!;
        setActiveTabId(neighbor.id);
        invalidateAndBroadcast(neighbor.id);
      }
    },
    [activeTabId, invalidateAndBroadcast, persistTabsToStorage, queryClient],
  );

  const renameActiveTab = useCallback((name: string) => {
    if (!activeTabId) return;
    setOpenTabs((prev) => {
      const next = prev.map((t) =>
        t.id === activeTabId ? { ...t, name } : t,
      );
      openTabsRef.current = next;
      return next;
    });
  }, [activeTabId]);

  const updateTabName = useCallback((id: string, name: string) => {
    setOpenTabs((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, name } : t));
      openTabsRef.current = next;
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      tournamentId,
      tournamentName,
      openTabs,
      ready,
      tournaments,
      refreshTournaments,
      openEventInTab,
      selectTab,
      closeTab,
      renameActiveTab,
      updateTabName,
      selectTournament: openEventInTab,
      setActiveTournament: openEventInTab,
    }),
    [
      tournamentId,
      tournamentName,
      openTabs,
      ready,
      tournaments,
      refreshTournaments,
      openEventInTab,
      selectTab,
      closeTab,
      renameActiveTab,
      updateTabName,
    ],
  );

  return (
    <EventWorkspaceContext.Provider value={value}>
      {children}
    </EventWorkspaceContext.Provider>
  );
}
