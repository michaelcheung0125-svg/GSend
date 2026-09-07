import { useState } from "react";
import type { GSendClient, Snapshot } from "../core/client";
import { directPickerSupported } from "../core/sink";
import { useI18n } from "../i18n";

interface Props {
  client: GSendClient;
  state: Snapshot;
  /** Whatever is staged on the landing screen, so a device row can send it outright. */
  files: File[];
  text: string;
}

/**
 * The devices this one has been paired with, and whether they are reachable now.
 *
 * Presence comes from the rendezvous room, which this device joins on load, so a row
 * says "online" only while the other device also has the page open. Clicking one skips
 * the code entirely: the pairing already established who they are to each other.
 */
export default function DeviceList({ client, state, files, text }: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!state.identity) {
    return (
      <div>
        <h4 className="side-title">{t("devices.title")}</h4>
        <p className="sub">{t("devices.notRemembered")}</p>
      </div>
    );
  }

  const staged = files.length > 0 || text.trim().length > 0;
  const label = staged ? t("devices.send") : t("devices.connect");

  const commitName = () => {
    setEditing(false);
    if (draft.trim()) void client.rename(draft);
  };

  return (
    <div>
      <h4 className="side-title">{t("devices.title")}</h4>

      <ul className="devices">
        <li className="device device--self">
          <span className={state.groupOnline ? "device__dot" : "device__dot device__dot--off"} aria-hidden="true" />
          {editing ? (
            <input
              className="composer__input device__rename"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitName();
                if (event.key === "Escape") setEditing(false);
              }}
              aria-label={t("devices.namePrompt")}
            />
          ) : (
            <span className="device__name">{state.identity.name}</span>
          )}
          <span className="device__meta">{t("devices.thisDevice")}</span>
          {!editing && (
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => {
                setDraft(state.identity?.name ?? "");
                setEditing(true);
              }}
            >
              {t("devices.rename")}
            </button>
          )}
        </li>

        {state.devices.map((device) => (
          <li key={device.id} className={device.online ? "device" : "device device--off"}>
            <span
              className={device.online ? "device__dot" : "device__dot device__dot--off"}
              aria-hidden="true"
            />
            <span className="device__name" title={device.id}>
              {device.name}
            </span>
            <span className="device__meta">
              {device.online ? t("devices.online") : t("devices.offline")}
            </span>
            <button
              type="button"
              className="btn btn--primary btn--tiny"
              disabled={!device.online}
              onClick={() => client.connectToDevice(device.id, files, text.trim() || null)}
            >
              {label}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => void client.unpair(device.id)}
            >
              {t("devices.unpair")}
            </button>
          </li>
        ))}
      </ul>

      <p className="sub" style={{ marginTop: 14 }}>
        {state.devices.length === 0 ? t("devices.none") : t("devices.offlineNote")}
      </p>

      {/*
        A paired device receives without anyone pressing anything, so its destination
        has to be settled beforehand rather than on a click that never comes. Chosen
        once, it is remembered for as long as the pairing is.
      */}
      {directPickerSupported() && (
        <p className="sub" style={{ marginTop: 10 }}>
          {state.savingTo
            ? t("devices.savingTo", { folder: state.savingTo })
            : t("devices.savingNowhere")}
          <button
            type="button"
            className="btn btn--ghost btn--tiny"
            style={{ marginLeft: 8 }}
            onClick={() => void client.chooseFolder()}
          >
            {t(state.savingTo ? "devices.changeFolder" : "transfer.chooseFolder")}
          </button>
        </p>
      )}

      {state.devices.length > 0 && (
        <button
          type="button"
          className="btn btn--ghost btn--tiny"
          style={{ marginTop: 6 }}
          onClick={() => void client.unpairAll()}
        >
          {t("devices.unpairAll")}
        </button>
      )}
    </div>
  );
}
