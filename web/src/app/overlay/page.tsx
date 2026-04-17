import { OverlayEntry } from "./overlay-entry";

/**
 * Route shell stays a Server Component; the scoreboard/bracket UI mounts only on the client
 * (`ssr: false`) so iframe + query-string contexts never hydrate mismatched HTML.
 */
export default function OverlayPage() {
  return <OverlayEntry />;
}
