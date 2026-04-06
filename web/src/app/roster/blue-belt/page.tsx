import { RosterClient } from "../RosterClient";

export default function BlueBeltRosterPage() {
  return (
    <RosterClient
      eventKind="BLUE_BELT"
      title="Blue belt event — roster"
      subtitle="Team names and seeds are independent of the Purple/Brown event."
      shellClassName="bg-gradient-to-b from-blue-950 via-blue-950/95 to-slate-950"
    />
  );
}
