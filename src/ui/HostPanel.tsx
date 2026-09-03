import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { GSendClient, Snapshot } from "../core/client";
import { formatBytes } from "../core/sink";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

/** The code is joinable for this long; the countdown bar drains against it. */
const JOIN_WINDOW_S = 60;

export default function HostPanel({ client, state }: Props) {
  const { t } = useI18n();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const remaining = useCountdown(state.joinExpiresAt);

  useEffect(() => {
    if (!state.shareUrl) return;
    let cancelled = false;
    QRCode.toDataURL(state.shareUrl, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => setQr(null));
    return () => {
      cancelled = true;
    };
  }, [state.shareUrl]);

  const copy = async () => {
    if (!state.shareUrl) return;
    try {
      await navigator.clipboard.writeText(state.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the link is on screen anyway */
    }
  };

  if (state.phase === "creating") {
    return (
      <section className="ended">
        <div className="kicker">{t("host.kicker")}</div>
        <h2 className="display display--md">{t("host.creating")}</h2>
        <p className="ended__lede">{t("host.reserving")}</p>
      </section>
    );
  }

  return (
    <section className="screen screen--host">
      <div>
        <div className="kicker">{t("host.kicker")}</div>
        <h2 className="display display--md">{t("host.title")}</h2>
        <p className="sub" style={{ marginBottom: 30 }}>
          {t("host.subtitle")}
        </p>

        <div className="code-display" aria-label={t("host.codeLabel", { code: state.code ?? "" })}>
          {(state.code ?? "").split("").map((digit, index) => (
            <span key={index} className="code-display__digit">
              {digit}
            </span>
          ))}
        </div>

        <div className="countdown-row">
          <div className="countdown-row__track">
            <div
              className="countdown-row__fill"
              style={{ width: `${Math.max(0, Math.min(100, (remaining / JOIN_WINDOW_S) * 100))}%` }}
            />
          </div>
          <span className={remaining <= 10 ? "countdown countdown--urgent" : "countdown"}>
            {remaining > 0 ? t("host.expiresIn", { seconds: remaining }) : t("host.expired")}
          </span>
        </div>

        <p className="alert alert--soft" style={{ marginTop: 20 }}>
          {!state.pendingShare
            ? t("host.queuedNothing")
            : state.pendingShare.files > 0
              ? t("host.queuedFiles", {
                  count: state.pendingShare.files,
                  size: formatBytes(state.pendingShare.bytes),
                })
              : t("host.queuedText")}
        </p>

        <p className="sub" style={{ marginTop: 22, maxWidth: "52ch" }}>
          {t("host.burnNote")}
        </p>
      </div>

      <div className="screen__rule" aria-hidden="true" />

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {qr && (
          <div className="qr-plate">
            <img className="qr" src={qr} alt={t("host.qrAlt")} width={284} height={284} />
          </div>
        )}
        {state.shareUrl && (
          <button type="button" className="btn btn--secondary link-copy" onClick={copy}>
            <span>{state.shareUrl.replace(/^https?:\/\//, "")}</span>
            <span className="link-copy__hint">{copied ? t("host.linkCopied") : t("host.copy")}</span>
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          style={{ alignSelf: "flex-start" }}
          onClick={() => client.reset()}
        >
          {t("host.cancel")}
        </button>
      </div>
    </section>
  );
}

function useCountdown(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline]);

  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
