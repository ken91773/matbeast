import { RosterClient } from "../RosterClient";

export default function PurpleBrownRosterPage() {
  return (
    <RosterClient
      eventKind="PURPLE_BROWN"
      title="Purple / Brown belts event — roster"
      subtitle="Separate teams and seeds from the Blue Belt event."
      shellClassName="bg-gradient-to-b from-[#3d2817] via-[#2c1d12] to-zinc-950"
    />
  );
}
