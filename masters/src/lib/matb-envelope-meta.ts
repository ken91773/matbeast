/**
 * Reads `trainingMode` from a saved .matb envelope (JSON root).
 * Returns `undefined` when absent or unparsable so callers leave the DB unchanged.
 */
export function trainingModeFromMatbBytes(bytes: Buffer): boolean | undefined {
  try {
    const text = bytes.toString("utf8");
    if (text.length > 25 * 1024 * 1024) return undefined;
    const j = JSON.parse(text) as { kind?: unknown; trainingMode?: unknown };
    if (j?.kind !== "matbeast-event") return undefined;
    if (typeof j.trainingMode === "boolean") return j.trainingMode;
    return undefined;
  } catch {
    return undefined;
  }
}
