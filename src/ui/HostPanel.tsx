import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { GSendClient, Snapshot } from "../core/client";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
}

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
      <section className="card card--centered">
        <h1 className="card__title">{t("host.creating")}</h1>
        <p className="muted">{t("host.reserving")}</p>
      </section>
    );
  }

  return (
    <section className="card card--centered">
      <h1 className="card__title">{t("host.title")}</h1>
      <p className="muted">{t("host.subtitle")}</p>

      <div className="code-display" aria-label={t("host.codeLabel", { code: state.code ?? "" })}>
        {(state.code ?? "").split("").map((digit, index) => (
          <span key={index} className="code-display__digit">
            {digit}
          </span>
        ))}
      </div>

      <p className={remaining <= 10 ? "countdown countdown--urgent" : "countdown"}>
        {remaining > 0 ? t("host.expiresIn", { seconds: remaining }) : t("host.expired")}
      </p>

      {qr && <img className="qr" src={qr} alt={t("host.qrAlt")} width={220} height={220} />}

      {state.pendingShare && (
        <p className="alert alert--soft">
          {state.pendingShare.files > 0
            ? t("host.sharePendingFiles", { count: state.pendingShare.files })
            : t("host.sharePendingText")}
        </p>
      )}

      {state.shareUrl && (
        <button type="button" className="btn btn--ghost link-copy" onClick={copy}>
          {copied ? t("host.linkCopied") : state.shareUrl.replace(/^https?:\/\//, "")}
        </button>
      )}

      <button type="button" className="btn" onClick={() => client.reset()}>
        {t("host.cancel")}
      </button>
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
