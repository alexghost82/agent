"use client";

import { Icon } from "../icons";
import type { GhostData } from "../useGhostData";

export function Login({ g }: { g: GhostData }) {
  const { t, rtl, lang, setLang, theme, setTheme } = g;
  return (
    <div className={`login-wrap ${rtl ? "rtl" : ""}`}>
      <div className="login-top">
        <div className="seg">
          <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
            EN
          </button>
          <button className={lang === "he" ? "on" : ""} onClick={() => setLang("he")}>
            HEB
          </button>
          <button className={lang === "ru" ? "on" : ""} onClick={() => setLang("ru")}>
            RU
          </button>
        </div>
        <button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="theme">
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </div>
      <form className="login-card" onSubmit={g.doLogin}>
        <img src="/ghost-lockup.png" alt="GHOST Agent Builder" className="login-logo" />
        <p className="login-sub">{t.login.title}</p>
        <label>{t.login.username}</label>
        <input
          value={g.loginUser}
          onChange={(e) => g.setLoginUser(e.target.value)}
          placeholder="Alex"
          autoFocus
          autoComplete="username"
        />
        <label>{t.login.password}</label>
        <input
          type="password"
          value={g.loginPass}
          onChange={(e) => g.setLoginPass(e.target.value)}
          placeholder={"\u2022\u2022\u2022\u2022\u2022\u2022"}
          autoComplete="current-password"
        />
        {g.loginErr ? <div className="login-err">{g.loginErr}</div> : null}
        <button className="primary" type="submit" disabled={g.loginLoading || !g.loginUser.trim() || !g.loginPass}>
          {g.loginLoading ? t.login.signingIn : t.login.signIn}
        </button>
      </form>
    </div>
  );
}
