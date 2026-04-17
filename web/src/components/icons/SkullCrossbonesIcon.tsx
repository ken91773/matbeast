/** Small “skull + crossed bones” affordance for destructive / master-remove actions. */
export function SkullCrossbonesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M5 5l14 14M19 5L5 19"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity={0.42}
      />
      <circle cx="9" cy="10" r="1.25" fill="currentColor" />
      <circle cx="15" cy="10" r="1.25" fill="currentColor" />
      <path
        d="M8.5 18.5h7M16 18.5a2 2 0 0 0 1.45-3.35 6.25 6.25 0 1 0-10.9 0A2 2 0 0 0 8 18.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
