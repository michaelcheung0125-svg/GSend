import type { GSendClient, Snapshot } from "../core/client";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

/**
 * The mono status blocks are deliberately untranslated: they are the design's
 * CLI voice, and read as terminal output in either language.
 */
function routeBlock(state: Snapshot): string {
  const route = state.relayEngaged ? "relay · turn" : "direct";
  const code = state.code ?? "----";
  return `route   ${route}\njoined  code ${code} · burned`;
}

export default function PairingPanel({ client, state }: Props) {
  const { t } = useI18n();
  const hostDeciding = state.role === "host" && state.channelsOpen && state.approval === "pending";

  if (hostDeciding) {
    return (
      <section className="panel-card">
        <div className="kicker">{t("pairing.kicker")}</div>
        <h3 className="card__title">{t("pairing.deviceConnected")}</h3>
        <p>{t("pairing.approvePrompt")}</p>
        <div className="term">{routeBlock(state)}</div>
        <div className="panel-card__actions">
          <button type="button" className="btn btn--primary btn--lg" onClick={() => client.approve()}>
            {t("pairing.approve")}
          </button>
          <button type="button" className="btn btn--secondary btn--lg" onClick={() => client.reject()}>
            {t("pairing.decline")}
          </button>
        </div>
      </section>
    );
  }

  // An open data channel outranks a stale departure notice from signalling.
  const waitingForPeer = state.peerAbsentSince !== null && !state.channelsOpen;

  const title = waitingForPeer
    ? t("pairing.waitingTitle")
    : state.channelsOpen
      ? t("pairing.almostThere")
      : t("pairing.connecting");

  const message = waitingForPeer
    ? t("pairing.waitingBody")
    : state.role === "guest" && state.channelsOpen
      ? t("pairing.waitingApproval")
      : t("pairing.connectingBody");

  const statusLines = `stun    ok\nturn    ${state.relayEngaged ? "engaged" : "standby"}`;

  return (
    <section className="panel-card">
      <div className="kicker kicker--muted">{t("pairing.connecting")}</div>
      <h3 className="card__title">{title}</h3>
      <p>{message}</p>
      <div className="ice-wait" aria-hidden="true">
        <span className="ice-wait__bar">████████████████████████</span>
        <span style={{ color: "var(--ink-55)" }}>ICE</span>
      </div>
      <div className="term term--muted">{statusLines}</div>
      {state.connection === "failed" && <p className="alert">{t("pairing.noDirectRoute")}</p>}
    </section>
  );
}
