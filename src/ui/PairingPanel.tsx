import type { GSendClient, Snapshot } from "../core/client";
import { directPickerSupported } from "../core/sink";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

export default function PairingPanel({ client, state }: Props) {
  const { t } = useI18n();

  // An open data channel outranks a stale departure notice from signalling.
  const waitingForPeer = state.peerAbsentSince !== null && !state.channelsOpen;

  const title = waitingForPeer
    ? t("pairing.waitingTitle")
    : state.channelsOpen
      ? t("pairing.almostThere")
      : t("pairing.connecting");

  // A device session has a name to put on the wait, and a verification step the person
  // should be told about rather than left guessing at.
  const peer = state.devices.find((device) => device.id === state.peerDevice);
  const message = waitingForPeer
    ? t("pairing.waitingBody")
    : peer
      ? state.channelsOpen
        ? t("devices.verifying", { name: peer.name })
        : t("devices.connecting", { name: peer.name })
      : t("pairing.connectingBody");

  const statusLines = `stun    ok\nturn    ${state.relayEngaged ? "engaged" : "standby"}`;

  /*
    Arriving by QR or link joins without anyone pressing anything, so there was no
    click to hang the folder picker off. Connecting takes a moment either way, and
    offering the choice here fills it — take it and files stream to disk, skip it and
    they land in browser storage instead.
  */
  const offerFolder = directPickerSupported() && state.savingTo === null;

  return (
    <section className="panel-card">
      <div className="kicker kicker--muted">{t("pairing.connecting")}</div>
      <h3 className="card__title">{title}</h3>
      <p>{message}</p>
      {offerFolder && (
        <div className="panel-card__actions">
          <button
            type="button"
            className="btn btn--primary btn--lg"
            onClick={() => void client.chooseFolder()}
          >
            {t("transfer.chooseFolder")}
          </button>
        </div>
      )}
      <div className="ice-wait" aria-hidden="true">
        <span className="ice-wait__bar">████████████████████████</span>
        <span style={{ color: "var(--ink-55)" }}>ICE</span>
      </div>
      <div className="term term--muted">{statusLines}</div>
      {state.connection === "failed" && <p className="alert">{t("pairing.noDirectRoute")}</p>}
    </section>
  );
}
