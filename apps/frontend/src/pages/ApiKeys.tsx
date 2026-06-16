// API key management: reveal-once banner, create form, table of existing keys.

import { useEffect, useState } from "react";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiError,
  type ApiKeySummary,
} from "../api.js";
import { PageHeader } from "../layout/PageHeader.js";
import { fmtDay } from "../lib/format.js";

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [keyLabel, setKeyLabel] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () =>
    listApiKeys()
      .then((k) => setKeys(k.keys))
      .catch((err) => setError((err as ApiError).message ?? "Could not load keys."));

  useEffect(() => {
    refresh();
  }, []);

  const onCreateKey = async () => {
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const res = await createApiKey(keyLabel.trim() || undefined);
      setNewKey(res.key);
      setKeyLabel("");
      await refresh();
    } catch (err) {
      setError((err as ApiError).message ?? "Could not create key.");
    }
  };

  const onRevoke = async (id: string) => {
    setError(null);
    setNotice(null);
    try {
      await revokeApiKey(id);
      setNotice("Key revoked.");
      await refresh();
    } catch (err) {
      setError((err as ApiError).message ?? "Could not revoke key.");
    }
  };

  const onCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard blocked — value is still selectable */
    }
  };

  return (
    <>
      <PageHeader title="API keys" subtitle="Authenticate scrape requests with a key. A key is shown only once at creation." />

      {error && <div className="banner error anim">{error}</div>}
      {notice && <div className="banner notice anim">{notice}</div>}

      <section className="panel anim">
        {newKey && (
          <div className="banner reveal">
            <strong>Copy your new key now — it won't be shown again.</strong>
            <div className="copy-row">
              <code className="key-reveal">{newKey}</code>
              <button className="btn" onClick={() => onCopy(newKey)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        <div className="row">
          <input
            type="text"
            placeholder="Label (optional)"
            value={keyLabel}
            onChange={(e) => setKeyLabel(e.target.value)}
          />
          <button className="btn" onClick={onCreateKey}>
            Create key
          </button>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td className="empty" colSpan={5}>
                  No keys yet.
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <tr key={k.id} className={k.revokedAt ? "revoked" : ""}>
                <td>
                  <code>{k.keyPrefix}…</code>
                </td>
                <td>{k.label ?? "—"}</td>
                <td className="when">{fmtDay(k.createdAt)}</td>
                <td className="when">{k.lastUsedAt ? fmtDay(k.lastUsedAt) : "—"}</td>
                <td>
                  {k.revokedAt ? (
                    <span className="muted">revoked</span>
                  ) : (
                    <button className="btn-link danger" onClick={() => onRevoke(k.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
