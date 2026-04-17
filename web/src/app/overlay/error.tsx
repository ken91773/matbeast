"use client";

/**
 * Surfaces real overlay failures (otherwise Next shows a generic “Application error” shell).
 */
export default function OverlayError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950 p-6 text-center text-zinc-100">
      <p className="text-sm font-semibold uppercase tracking-wide text-amber-200">
        Overlay could not load
      </p>
      <pre className="max-h-[40vh] max-w-full overflow-auto rounded border border-zinc-700 bg-zinc-900/80 p-3 text-left text-xs text-red-200">
        {error.message}
      </pre>
      {error.digest ? (
        <p className="text-[10px] text-zinc-500">Digest: {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="rounded border border-zinc-600 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
      >
        Try again
      </button>
    </div>
  );
}
