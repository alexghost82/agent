"use client";

import { useCallback, useEffect, useState } from "react";
import type { GhostData } from "../../useGhostData";
import {
  KEYS_MOCK,
  KEY_PLACEHOLDER,
  KEY_RX,
  PROVIDER_LABEL,
  type KeysStatus,
  type ProviderId,
  type TestResult,
  errorText,
  keyBody,
  meGetKeys,
  mePutKeys,
  meTestKey
} from "../../api";

const PROVIDERS: ProviderId[] = ["openai", "gemini"];

export function SettingsPanel({ g }: { g: GhostData }) {
  const { t } = g;

  const [keys, setKeys] = useState<KeysStatus | null>(null);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysErr, setKeysErr] = useState("");
  const [keyInput, setKeyInput] = useState<Record<ProviderId, string>>({ openai: "", gemini: "" });
  const [keyFieldErr, setKeyFieldErr] = useState<Record<ProviderId, string>>({ openai: "", gemini: "" });
  const [keyMsg, setKeyMsg] = useState<Record<ProviderId, string>>({ openai: "", gemini: "" });
  const [keyTest, setKeyTest] = useState<Record<ProviderId, TestResult | null>>({ openai: null, gemini: null });
  const [keyBusy, setKeyBusy] = useState("");

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    setKeysErr("");
    try {
      setKeys(await meGetKeys());
    } catch (e: unknown) {
      setKeysErr(errorText(t, e) || t.keysLoadError);
    } finally {
      setKeysLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  async function saveKey(provider: ProviderId) {
    const raw = keyInput[provider].trim();
    setKeyMsg((m) => ({ ...m, [provider]: "" }));
    setKeyTest((m) => ({ ...m, [provider]: null }));
    if (!raw) {
      setKeyFieldErr((m) => ({ ...m, [provider]: t.keyEnterFirst }));
      return;
    }
    if (!KEY_RX[provider].test(raw)) {
      setKeyFieldErr((m) => ({ ...m, [provider]: provider === "openai" ? t.keyInvalidOpenai : t.keyInvalidGemini }));
      return;
    }
    setKeyFieldErr((m) => ({ ...m, [provider]: "" }));
    setKeyBusy(`save:${provider}`);
    try {
      const res = await mePutKeys(keyBody(provider, raw));
      setKeys(res);
      setKeyInput((m) => ({ ...m, [provider]: "" }));
      setKeyMsg((m) => ({ ...m, [provider]: t.keySaved }));
    } catch (e: unknown) {
      setKeyFieldErr((m) => ({ ...m, [provider]: errorText(t, e) || t.keyTestFail }));
    } finally {
      setKeyBusy("");
    }
  }

  async function removeKey(provider: ProviderId) {
    setKeyMsg((m) => ({ ...m, [provider]: "" }));
    setKeyTest((m) => ({ ...m, [provider]: null }));
    setKeyFieldErr((m) => ({ ...m, [provider]: "" }));
    setKeyBusy(`remove:${provider}`);
    try {
      const res = await mePutKeys(keyBody(provider, null));
      setKeys(res);
      setKeyInput((m) => ({ ...m, [provider]: "" }));
      setKeyMsg((m) => ({ ...m, [provider]: t.keyRemoved }));
    } catch (e: unknown) {
      setKeyFieldErr((m) => ({ ...m, [provider]: errorText(t, e) || t.keyTestFail }));
    } finally {
      setKeyBusy("");
    }
  }

  async function changeProvider(provider: ProviderId) {
    if (keys?.provider === provider || keyBusy) return;
    setKeysErr("");
    setKeyBusy(`provider:${provider}`);
    try {
      setKeys(await mePutKeys({ provider }));
    } catch (e: unknown) {
      setKeysErr(errorText(t, e) || t.keysLoadError);
    } finally {
      setKeyBusy("");
    }
  }

  async function testKey(provider: ProviderId) {
    setKeyTest((m) => ({ ...m, [provider]: null }));
    setKeyBusy(`test:${provider}`);
    try {
      const res = await meTestKey(provider);
      setKeyTest((m) => ({ ...m, [provider]: res }));
    } catch (e: unknown) {
      setKeyTest((m) => ({ ...m, [provider]: { ok: false, error: errorText(t, e) } }));
    } finally {
      setKeyBusy("");
    }
  }

  return (
    <section className="panel">
      <div className="explain">{t.settingsExplain}</div>
      {KEYS_MOCK ? <div className="badge-line">{t.keyMockNote}</div> : null}
      {keysErr ? (
        <div className="result-box err">
          <strong>{t.errorWord}:</strong> {keysErr}
        </div>
      ) : null}

      <div className="form-card">
        <h3 className="card-title">{t.activeProvider}</h3>
        <div className="seg provider-seg">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              className={keys?.provider === p ? "on" : ""}
              onClick={() => changeProvider(p)}
              disabled={keysLoading || keyBusy.startsWith("provider")}
            >
              {PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          {t.activeProviderHint}
        </p>
      </div>

      {PROVIDERS.map((p) => {
        const st = keys?.keys?.[p];
        const configured = !!st?.configured;
        const test = keyTest[p];
        return (
          <div key={p} className="form-card">
            <div className="key-head">
              <h3 className="card-title" style={{ margin: 0 }}>
                {PROVIDER_LABEL[p]}
              </h3>
              <div className="key-badges">
                {keys?.provider === p ? <span className="status status-approved">{t.providerActiveBadge}</span> : null}
                <span className={`status ${configured ? "status-ready" : ""}`}>
                  {configured ? `${t.statusConfigured} \u2022 \u2022\u2022\u2022\u2022${st?.last4 ?? ""}` : t.statusNotConfigured}
                </span>
              </div>
            </div>
            {configured && st?.updatedAt ? (
              <p className="muted">
                {t.keyUpdatedAt}: {new Date(st.updatedAt).toLocaleString()}
              </p>
            ) : null}

            <label>{t.apiKeyLabel}</label>
            <input
              type="password"
              value={keyInput[p]}
              placeholder={KEY_PLACEHOLDER[p]}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value;
                setKeyInput((m) => ({ ...m, [p]: v }));
                if (keyFieldErr[p]) setKeyFieldErr((m) => ({ ...m, [p]: "" }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveKey(p);
              }}
            />
            {keyFieldErr[p] ? (
              <div className="login-err" style={{ marginTop: 8 }}>
                {keyFieldErr[p]}
              </div>
            ) : null}

            <div className="key-actions">
              <button className="primary" onClick={() => saveKey(p)} disabled={keyBusy === `save:${p}` || !keyInput[p].trim()}>
                {keyBusy === `save:${p}` ? t.keySaving : t.keySaveBtn}
              </button>
              <button className="ghost" onClick={() => testKey(p)} disabled={!configured || keyBusy === `test:${p}`}>
                {keyBusy === `test:${p}` ? t.keyTesting : t.keyTestBtn}
              </button>
              <button className="ghost danger-btn" onClick={() => removeKey(p)} disabled={!configured || keyBusy === `remove:${p}`}>
                {keyBusy === `remove:${p}` ? t.keyRemoving : t.keyRemoveBtn}
              </button>
            </div>

            {keyMsg[p] ? (
              <span className="badge-line" style={{ display: "block", marginTop: 12 }}>
                {keyMsg[p]}
              </span>
            ) : null}
            {test ? (
              <div className={`result-box ${test.ok ? "" : "err"}`} style={{ marginTop: 10 }}>
                {test.ok ? t.keyTestOk : `${t.keyTestFail}${test.error ? `: ${test.error}` : ""}`}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
