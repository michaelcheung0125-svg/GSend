import { useEffect, useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import { formatBytes, maxFileBytes, prepareStorage } from "../core/sink";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
  prefill: string;
}

export default function Landing({ client, state, prefill }: Props) {
  const { t, tm } = useI18n();
  const [code, setCode] = useState(prefill);
  const [limit, setLimit] = useState(() => maxFileBytes());

  useEffect(() => {
    if (prefill) setCode(prefill);
  }, [prefill]);

  // The ceiling depends on whether this browser will actually give us disk.
  useEffect(() => {
    let cancelled = false;
    void prepareStorage().then(() => {
      if (!cancelled) setLimit(maxFileBytes());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    client.join(code);
  };

  return (
    <section className="card card--centered">
      <h1 className="card__title">{t("landing.title")}</h1>
      <p className="muted">{t("landing.subtitle", { size: formatBytes(limit) })}</p>

      {state.error && <p className="alert">{tm(state.error)}</p>}

      <button type="button" className="btn btn--primary btn--lg" onClick={() => client.host()}>
        {t("landing.start")}
      </button>

      <div className="divider">
        <span>{t("landing.orJoin")}</span>
      </div>

      <form className="code-form" onSubmit={submit}>
        <input
          className="code-input"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="0000"
          aria-label={t("landing.codeLabel")}
        />
        <button type="submit" className="btn btn--lg" disabled={code.length !== 4}>
          {t("landing.join")}
        </button>
      </form>
    </section>
  );
}
