import Link from "next/link";
import DesktopUpdatePanel from "@/components/DesktopUpdatePanel";

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-950 p-8 text-zinc-100">
      <h1 className="text-2xl font-semibold tracking-tight">Mat Beast Scoreboard</h1>
      <nav className="mt-6 flex flex-wrap gap-4 text-amber-500">
        <Link className="hover:underline" href="/roster">
          Rosters
        </Link>
        <Link className="hover:underline" href="/roster/blue-belt">
          Blue belt roster
        </Link>
        <Link className="hover:underline" href="/roster/purple-brown">
          Purple/Brown roster
        </Link>
        <Link className="hover:underline" href="/control">
          Control
        </Link>
        <Link className="hover:underline" href="/overlay">
          Overlay
        </Link>
      </nav>
      <p className="mt-8 max-w-xl text-zinc-400">
        First run: copy <code className="text-zinc-300">.env.example</code> to{" "}
        <code className="text-zinc-300">.env</code>, then{" "}
        <code className="text-zinc-300">npm install</code>,{" "}
        <code className="text-zinc-300">npx prisma generate</code>,{" "}
        <code className="text-zinc-300">npx prisma db push</code>,{" "}
        <code className="text-zinc-300">npm run dev</code>. Open{" "}
        <code className="text-zinc-300">/overlay</code> in OBS Browser Source
        (1920×1080).
      </p>
      <DesktopUpdatePanel />
    </main>
  );
}
