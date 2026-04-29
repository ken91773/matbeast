/**
 * NDI network-adapter discovery (v0.9.33).
 *
 * Why this exists:
 *   v0.9.29–v0.9.32 confirmed the entire NDI pipeline works on the same
 *   PC as the sender, but cross-PC delivery silently fails because NDI
 *   announces on every network interface Windows reports — including
 *   APIPA (169.254.*) addresses on Ethernet adapters with no DHCP, on
 *   Bluetooth Network Connection, and on idle Wi-Fi Direct virtual
 *   adapters. Even Newtek's own Test Pattern Generator hits the same
 *   bug. The professional broadcast fix is to pin NDI to a specific
 *   adapter via `ndi-config.v1.json` (see ndi-config.js).
 *
 * What this module does:
 *   - Walks `os.networkInterfaces()`, classifies every IPv4 address as
 *     `routable` (real LAN IP), `apipa` (169.254.*), `loopback`
 *     (127.*), or `virtual` (well-known synthetic IPs from Hyper-V,
 *     VirtualBox, Docker etc. — best-effort heuristic).
 *   - Maps each address to a Windows-friendly NIC name ("Wi-Fi",
 *     "Ethernet", "Bluetooth Network Connection", "Local Area
 *     Connection* 1") so menu items and the dashboard status pill
 *     can read in plain English instead of dotted-quad IPs.
 *   - Provides `pickAutoBinding(adapters, preference)` so the app can
 *     honour an "Auto-select (prefer Ethernet)" default — picks the
 *     first routable Ethernet IP, then the first routable Wi-Fi IP,
 *     then any other routable IP, then null (let NDI use everything).
 *   - Stable across Windows builds — `os.networkInterfaces()` returns
 *     consistent NIC names matching the Network Connections UI, with
 *     no PowerShell shell-out required.
 *
 * Caveats:
 *   - The "type" classification (Wi-Fi / Ethernet / Bluetooth / virtual)
 *     is a heuristic on the NIC name. Windows doesn't expose a stable
 *     "is Wi-Fi" flag through node:os; we match common substrings. A
 *     non-default-named adapter ("Ether1", "Lan2") falls through to
 *     "Ethernet (or other physical)" and still works.
 *   - On non-Windows platforms (we only ship Windows but the code may
 *     run during macOS / Linux dev builds) the heuristic returns
 *     "Network adapter" for everything; auto-selection still picks
 *     routable over APIPA.
 *   - Multi-IP-per-NIC (e.g. one adapter with both DHCP and APIPA
 *     addresses, or with multiple manually-assigned IPs) returns one
 *     entry per IP. Auto-binding picks the routable one.
 */
const os = require("node:os");

/** APIPA (Automatic Private IP Addressing) prefix — link-local only,
 *  not routable. Windows assigns these when DHCP fails. */
function isApipa(ip) {
  return typeof ip === "string" && ip.startsWith("169.254.");
}

function isLoopback(ip) {
  return typeof ip === "string" && ip.startsWith("127.");
}

/** Best-effort virtual-NIC detection by IP range. Real LAN IPs in
 *  these ranges are rare; collisions only matter for the auto-select
 *  preference order so a false positive at most demotes a valid IP. */
function isLikelyVirtualIp(ip) {
  if (typeof ip !== "string") return false;
  // Hyper-V default switch
  if (ip.startsWith("172.") && /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) {
    // 172.16-172.31 is private but also Hyper-V default — treat as
    // possibly-virtual; auto-select prefers other ranges if available.
    return true;
  }
  // VirtualBox default Host-Only adapter
  if (ip.startsWith("192.168.56.")) return true;
  // VMware default
  if (ip.startsWith("192.168.92.") || ip.startsWith("192.168.66.")) return true;
  return false;
}

/** Friendly classification + sortable preference for the auto-binding
 *  picker. Lower preferenceRank = picked first. */
function classifyAdapter(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith("wi-fi") || lower.includes("wireless")) {
    return { type: "wifi", friendly: "Wi-Fi", preferenceRank: 20 };
  }
  if (lower.startsWith("ethernet")) {
    return { type: "ethernet", friendly: "Ethernet", preferenceRank: 10 };
  }
  if (lower.includes("bluetooth")) {
    return { type: "bluetooth", friendly: "Bluetooth", preferenceRank: 90 };
  }
  if (lower.includes("loopback")) {
    return { type: "loopback", friendly: "Loopback", preferenceRank: 99 };
  }
  if (lower.includes("local area connection")) {
    /** Windows numbers Wi-Fi Direct / Hosted Network virtual adapters
     *  as "Local Area Connection* N". Always virtual; never used for
     *  real LAN traffic. */
    return {
      type: "virtual",
      friendly: lower.includes("local area connection*")
        ? "Wi-Fi Direct virtual adapter"
        : "Local area connection",
      preferenceRank: 95,
    };
  }
  if (
    lower.includes("vethernet") ||
    lower.includes("virtualbox") ||
    lower.includes("vmware") ||
    lower.includes("hyper-v") ||
    lower.includes("docker") ||
    lower.includes("vpn") ||
    lower.includes("tap-windows") ||
    lower.includes("tunnel") ||
    lower.includes("wan ")
  ) {
    return { type: "virtual", friendly: name, preferenceRank: 90 };
  }
  return { type: "other", friendly: name, preferenceRank: 50 };
}

/**
 * Enumerate every IPv4 address the OS reports, with name + class +
 * routable flag.
 *
 * @returns {AdapterEntry[]}
 *
 * @typedef {object} AdapterEntry
 * @property {string}  ip            IPv4 dotted-quad
 * @property {string}  adapterName   OS adapter name (e.g. "Wi-Fi")
 * @property {string}  friendlyName  human label for the menu (e.g. "Wi-Fi")
 * @property {string}  type          "ethernet"|"wifi"|"bluetooth"|"virtual"|"loopback"|"other"
 * @property {boolean} isApipa       true if 169.254.* (link-local only)
 * @property {boolean} isLoopback    true if 127.*
 * @property {boolean} isLikelyVirtual  best-effort virtual-NIC detection
 * @property {boolean} isRoutable    true if usable for cross-LAN NDI delivery
 *                                   (not APIPA, not loopback, not likely virtual)
 * @property {number}  preferenceRank lower = picked first by auto-binding
 */
function enumerateAdapters() {
  const ifaces = os.networkInterfaces();
  /** @type {AdapterEntry[]} */
  const out = [];
  for (const [adapterName, addrs] of Object.entries(ifaces)) {
    if (!Array.isArray(addrs)) continue;
    const cls = classifyAdapter(adapterName);
    for (const a of addrs) {
      if (!a || a.family !== "IPv4") continue;
      const apipa = isApipa(a.address);
      const loopback = isLoopback(a.address);
      const virtual = cls.type === "virtual" || isLikelyVirtualIp(a.address);
      const routable = !apipa && !loopback && !virtual;
      out.push({
        ip: a.address,
        adapterName,
        friendlyName: cls.friendly,
        type: cls.type,
        isApipa: apipa,
        isLoopback: loopback,
        isLikelyVirtual: virtual,
        isRoutable: routable,
        preferenceRank: cls.preferenceRank + (apipa ? 1000 : 0) + (virtual ? 500 : 0),
      });
    }
  }
  out.sort((a, b) => {
    if (a.preferenceRank !== b.preferenceRank) {
      return a.preferenceRank - b.preferenceRank;
    }
    return a.ip.localeCompare(b.ip);
  });
  return out;
}

/**
 * Pick the auto-binding IP for "Auto-select (prefer Ethernet)" mode.
 *
 *   - Prefers Ethernet with a routable IP (private 192.168/10/172.16-31
 *     ranges that aren't Hyper-V).
 *   - Falls back to Wi-Fi with a routable IP.
 *   - Falls back to any routable IP.
 *   - Returns null if nothing routable is found — caller writes no
 *     `adapters.allowed`, NDI uses default behaviour (all interfaces).
 *
 * @param {AdapterEntry[]} adapters
 * @returns {AdapterEntry | null}
 */
function pickAutoBinding(adapters) {
  const routable = adapters.filter((a) => a.isRoutable);
  if (routable.length === 0) return null;
  const ethernet = routable.find((a) => a.type === "ethernet");
  if (ethernet) return ethernet;
  const wifi = routable.find((a) => a.type === "wifi");
  if (wifi) return wifi;
  return routable[0];
}

/**
 * Resolve a saved binding preference (from `desktopPreferences
 * .ndiBindAdapter`) to a concrete adapter entry, or null.
 *
 * Preference shape:
 *   - `null` / `"auto"` → run pickAutoBinding
 *   - `{ kind: "auto" }` → run pickAutoBinding
 *   - `{ kind: "adapter", adapterName: "Ethernet" }` → first IPv4 on
 *     that adapter, even if APIPA (operator override)
 *   - `{ kind: "ip", ip: "10.0.0.20" }` → exact IP if still present
 *
 * @param {AdapterEntry[]} adapters
 * @param {object | string | null} preference
 * @returns {AdapterEntry | null}
 */
function resolveBinding(adapters, preference) {
  if (!preference || preference === "auto" || preference?.kind === "auto") {
    return pickAutoBinding(adapters);
  }
  if (preference?.kind === "ip" && preference.ip) {
    return adapters.find((a) => a.ip === preference.ip) || null;
  }
  if (preference?.kind === "adapter" && preference.adapterName) {
    return (
      adapters.find(
        (a) => a.adapterName === preference.adapterName && a.isRoutable,
      ) ||
      adapters.find((a) => a.adapterName === preference.adapterName) ||
      null
    );
  }
  return pickAutoBinding(adapters);
}

module.exports = {
  enumerateAdapters,
  pickAutoBinding,
  resolveBinding,
  classifyAdapter,
  isApipa,
  isLikelyVirtualIp,
};
