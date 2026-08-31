import type { GSendClient, Snapshot } from "../core/client";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

export default function PairingPanel({ client, state }: Props) {
  const { t } = useI18n();
  const hostDeciding = state.role === "host" && state.channelsOpen && state.approval === "pending";

  if (hostDeciding) {
    return (
      <section className="card card--centered">
        <h1 className="card__title">{t("pairing.deviceConnected")}</h1>
        <p className="muted">{t("pairing.approvePrompt")}</p>
        <div className="row">
          <button
            type="button"
            className="btn btn--primary btn--lg"
            onClick={() => client.approve()}
          >
            {t("pairing.approve")}
          </button>
          <button type="button" className="btn btn--danger btn--lg" onClick={() => client.reject()}>
            {t("pairing.decline")}
          </button>
        </div>
      </section>
    );
  }

  // An open data channel outranks a stale departure notice from signalling.
  const waitingForPeer = state.peerAbsentSince !== null && !state.channelsOpen;

  const message = waitingForPeer
    ? t("pairing.waitingBody")
    : state.role === "guest" && state.channelsOpen
      ? t("pairing.waitingApproval")
      : t("pairing.connectingBody");

  const title = waitingForPeer
    ? t("pairing.waitingTitle")
    : state.channelsOpen
      ? t("pairing.almostThere")
      : t("pairing.connecting");

  return (
    <section className="card card--centered">
      <h1 className="card__title">
        <span className="spinner" aria-hidden="true" />
        {title}
      </h1>
      <p className="muted">{message}</p>
      {state.connection === "failed" && <p className="alert">{t("pairing.noDirectRoute")}</p>}
    </section>
  );
}
