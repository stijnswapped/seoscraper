import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { getInvite, signup, type ApiError } from "../api.js";

type Status = "checking" | "valid" | "invalid";

export function Signup() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [status, setStatus] = useState<Status>("checking");
  const [pinnedEmail, setPinnedEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }
    getInvite(token)
      .then((res) => {
        if (!res.valid) {
          setStatus("invalid");
          return;
        }
        setPinnedEmail(res.email ?? null);
        setStatus("valid");
      })
      .catch(() => setStatus("invalid"));
  }, [token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signup(token, password, pinnedEmail ? undefined : email);
      navigate("/dashboard");
    } catch (err) {
      setError((err as ApiError).message ?? "Sign up failed.");
    } finally {
      setBusy(false);
    }
  };

  if (status === "checking") {
    return <div className="auth"><div className="auth-card"><p className="muted">Checking your invite…</p></div></div>;
  }

  if (status === "invalid") {
    return (
      <div className="auth">
        <div className="auth-card anim">
          <div className="mark">◧</div>
          <h1>Invite not valid</h1>
          <p className="subtitle">This signup link is invalid, expired, or has already been used. Ask your admin for a new one.</p>
          <Link className="btn btn-ghost" to="/login" style={{ textAlign: "center" }}>Go to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth-card anim">
        <div className="mark">◧</div>
        <h1>Create your account</h1>
        <p className="subtitle">Set a password to finish signing up.</p>
        <form onSubmit={onSubmit}>
          <label className="field">
            <span>Email</span>
            {pinnedEmail ? (
              <input type="email" value={pinnedEmail} disabled />
            ) : (
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            )}
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              minLength={8}
              required
            />
          </label>
          {error && <div className="banner error">{error}</div>}
          <button className="btn" type="submit" disabled={busy || password.length < 8}>
            {busy ? "Creating account…" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
