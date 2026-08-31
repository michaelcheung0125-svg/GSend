import type { GSendClient, Snapshot } from "../core/client";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

export default function PairingPanel({ client, state }: Props) {
  const hostDeciding = state.role === "host" && state.channelsOpen && state.approval === "pending";

  if (hostDeciding) {
    return (
      <section className="card card--centered">
        <h1 className="card__title">A device connected</h1>
        <p className="muted">
          Only continue if this was you or someone you are expecting. Nothing is sent until you
          approve.
        </p>
        <div className="row">
          <button type="button" className="btn btn--primary btn--lg" onClick={() => client.approve()}>
            Approve
          </button>
          <button type="button" className="btn btn--danger btn--lg" onClick={() => client.reject()}>
            Decline
          </button>
        </div>
      </section>
    );
  }

  // An open data channel outranks a stale departure notice from signalling.
  const waitingForPeer = state.peerAbsentSince !== null && !state.channelsOpen;

  const message = waitingForPeer
    ? "The other device dropped off. It has a few minutes to come back before this session closes."
    : state.role === "guest" && state.channelsOpen
      ? "Waiting for the other device to approve."
      : "Connecting to the other device…";

  return (
    <section className="card card--centered">
      <h1 className="card__title">
        <span className="spinner" aria-hidden="true" />
        {waitingForPeer ? "Waiting for the other device" : state.channelsOpen ? "Almost there" : "Connecting"}
      </h1>
      <p className="muted">{message}</p>
      {state.connection === "failed" && (
        <p className="alert">
          Could not open a direct connection on this network. Put both devices on the same Wi-Fi and
          try again.
        </p>
      )}
    </section>
  );
}
