import { useEffect, useState, type ReactNode } from "react";

const LINKS = {
  register: "https://www.smartproxy.org/register/?invitation_code=1WYSXE",
  residential: "https://www.smartproxy.org/user/residential/",
  subAccount: "https://www.smartproxy.org/user/residential/sub-account/",
  proxy: "https://www.smartproxy.org/user/residential/proxy/",
};

type Lang = "en" | "nl";

/** Open in a new tab, safely. */
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="ext-link">
      {children} ↗
    </a>
  );
}

const EXAMPLE_CURL = "curl -x smart-USERNAME:PASSWORD@proxy.smartproxy.net:3120 https://api.ip.cc";

/** $ → € converted manually (excl. VAT). */
const PLANS = [
  { gb: "10 GB", usd: "$9", eur: "≈ €8,50", recommended: true },
  { gb: "60 GB", usd: "$52", eur: "≈ €48" },
  { gb: "100 GB", usd: "$85", eur: "≈ €79" },
];

interface Step {
  title: Record<Lang, string>;
  body: Record<Lang, ReactNode>;
}

const PlanTable = ({ lang }: { lang: Lang }) => (
  <table className="plan-table">
    <thead>
      <tr>
        <th>{lang === "en" ? "Data" : "Data"}</th>
        <th>{lang === "en" ? "Price" : "Prijs"}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {PLANS.map((p) => (
        <tr key={p.gb} className={p.recommended ? "rec" : ""}>
          <td>{p.gb}</td>
          <td>{p.usd} <span className="muted">{p.eur}</span></td>
          <td>{p.recommended && <span className="chip on">{lang === "en" ? "Recommended" : "Aanbevolen"}</span>}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const STEPS: Step[] = [
  {
    title: { en: "Create your Smartproxy account", nl: "Maak je Smartproxy-account aan" },
    body: {
      en: (
        <>
          <p>Sign up using this link (it includes our invitation code):</p>
          <p><Ext href={LINKS.register}>Create a Smartproxy account</Ext></p>
        </>
      ),
      nl: (
        <>
          <p>Registreer via deze link (bevat onze uitnodigingscode):</p>
          <p><Ext href={LINKS.register}>Maak een Smartproxy-account aan</Ext></p>
        </>
      ),
    },
  },
  {
    title: { en: "Buy a residential plan", nl: "Koop een residential-abonnement" },
    body: {
      en: (
        <>
          <p>Go to the <Ext href={LINKS.residential}>Residential page</Ext> and choose a plan.</p>
          <PlanTable lang="en" />
          <p className="muted">
            Recommendation: we used ~20 GB in 2–3 weeks <em>before</em> the new bandwidth savings, with image/font
            blocking now on, <strong>10 GB</strong> is a comfortable starting point. You can always upgrade later.
          </p>
          <p className="muted">Prices are excl. VAT, your total may be higher depending on VAT.</p>
          <p>Then scroll down and pick a <strong>validity period</strong> before checking out.</p>
        </>
      ),
      nl: (
        <>
          <p>Ga naar de <Ext href={LINKS.residential}>Residential-pagina</Ext> en kies een abonnement.</p>
          <PlanTable lang="nl" />
          <p className="muted">
            Aanbeveling: we gebruikten ~20 GB in 2–3 weken <em>vóór</em> de nieuwe besparing, nu afbeeldingen/fonts
            worden geblokkeerd is <strong>10 GB</strong> een prima startpunt. Upgraden kan altijd later.
          </p>
          <p className="muted">Prijzen zijn excl. btw, je totaal kan hoger uitvallen door btw.</p>
          <p>Scroll daarna naar beneden en kies een <strong>geldigheidsduur</strong> vóór het afrekenen.</p>
        </>
      ),
    },
  },
  {
    title: { en: "Create a sub-user", nl: "Maak een sub-gebruiker aan" },
    body: {
      en: (
        <>
          <p>Open the <Ext href={LINKS.subAccount}>Sub-users page</Ext> and create a sub-user. You'll use its
            username and password for the proxy.</p>
        </>
      ),
      nl: (
        <>
          <p>Open de <Ext href={LINKS.subAccount}>Sub-gebruikers pagina</Ext> en maak een sub-gebruiker aan. Je
            gebruikt de gebruikersnaam en het wachtwoord hiervan voor de proxy.</p>
        </>
      ),
    },
  },
  {
    title: { en: "Generate your proxy", nl: "Genereer je proxy" },
    body: {
      en: (
        <>
          <p>Open the <Ext href={LINKS.proxy}>Proxy page</Ext>. In the <strong>Proxy Generator</strong> card:</p>
          <ul>
            <li>Code language: <strong>Shell</strong></li>
            <li>Select the <strong>sub-user</strong> you just created</li>
            <li>Country: <strong>Netherlands</strong> (leaving it <em>random</em> works even better)</li>
            <li>Under <strong>Generate proxy list</strong>, click <strong>Generate proxy</strong></li>
          </ul>
          <p>You'll get a command like:</p>
          <code className="code-block">{EXAMPLE_CURL}</code>
        </>
      ),
      nl: (
        <>
          <p>Open de <Ext href={LINKS.proxy}>Proxy-pagina</Ext>. In de <strong>Proxy Generator</strong> kaart:</p>
          <ul>
            <li>Code language: <strong>Shell</strong></li>
            <li>Kies de <strong>sub-gebruiker</strong> die je net aanmaakte</li>
            <li>Land: <strong>Netherlands</strong> (op <em>random</em> laten werkt zelfs beter)</li>
            <li>Onder <strong>Generate proxy list</strong>, klik op <strong>Generate proxy</strong></li>
          </ul>
          <p>Je krijgt een commando zoals:</p>
          <code className="code-block">{EXAMPLE_CURL}</code>
        </>
      ),
    },
  },
  {
    title: { en: "Paste it here", nl: "Plak het hier" },
    body: {
      en: (
        <>
          <p>Paste the <strong>whole curl command</strong> (or just the <code>user:pass@host:port</code> part) into the
            Proxy field and press <strong>Save</strong>. We'll clean it up automatically.</p>
          <p>Then create an <strong>API key</strong> below, and you're ready to scrape on your own proxy.</p>
        </>
      ),
      nl: (
        <>
          <p>Plak het <strong>volledige curl-commando</strong> (of alleen het <code>user:pass@host:port</code> deel) in
            het Proxy-veld en klik op <strong>Opslaan</strong>. Wij maken het automatisch netjes.</p>
          <p>Maak daarna hieronder een <strong>API-sleutel</strong> aan, en je kunt scrapen via je eigen proxy.</p>
        </>
      ),
    },
  },
];

const UI = {
  en: { title: "Set up your proxy", step: "Step", close: "Close", done: "Got it" },
  nl: { title: "Stel je proxy in", step: "Stap", close: "Sluiten", done: "Begrepen" },
};

export function ProxyHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const ui = UI[lang];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal anim" role="dialog" aria-modal="true" aria-label={ui.title} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{ui.title}</h2>
          <div className="modal-head-actions">
            <div className="segmented lang">
              <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
              <button className={lang === "nl" ? "on" : ""} onClick={() => setLang("nl")}>NL</button>
            </div>
            <button className="modal-close" aria-label={ui.close} onClick={onClose}>×</button>
          </div>
        </header>

        <div className="modal-body">
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={i} className="step">
                <div className="step-num">{i + 1}</div>
                <div className="step-content">
                  <h3>{s.title[lang]}</h3>
                  {s.body[lang]}
                </div>
              </li>
            ))}
          </ol>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>{ui.done}</button>
        </footer>
      </div>
    </div>
  );
}
