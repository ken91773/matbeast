import Link from "next/link";

export default function RosterHubPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-8 text-zinc-100">
      <h1 className="text-2xl font-semibold tracking-tight">Rosters</h1>
      <p className="mt-2 max-w-lg text-zinc-400">
        Blue belt and Purple/Brown belt events use separate team lists and entry
        forms. Open the page that matches your division.
      </p>
      <nav className="mt-8 flex flex-col gap-4 sm:flex-row">
        <Link
          href="/roster/blue-belt"
          className="rounded-lg border-2 border-blue-500/60 bg-blue-950/80 px-8 py-6 text-center text-lg font-semibold text-blue-100 shadow-lg shadow-blue-950/50 transition hover:bg-blue-900/80"
        >
          BLUE BELT roster
        </Link>
        <Link
          href="/roster/purple-brown"
          className="rounded-lg border-2 border-amber-900/80 bg-[#4a3728] px-8 py-6 text-center text-lg font-semibold text-amber-100 shadow-lg shadow-black/40 transition hover:bg-[#5c4432]"
        >
          PURPLE / BROWN BELTS roster
        </Link>
      </nav>
      <p className="mt-10 text-sm text-zinc-500">
        <Link className="text-amber-500 hover:underline" href="/">
          Home
        </Link>
      </p>
    </main>
  );
}
