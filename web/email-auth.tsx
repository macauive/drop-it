import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { api } from "./client.js";
import { NewPasswordFields } from "./new-password.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Please try again.";

export function EmailAuthForm({
  mode,
  onCancel,
  onComplete,
  disabled = false,
}: {
  mode: "signup" | "reset" | "link";
  onCancel?: () => void;
  onComplete: (email: string) => void;
  disabled?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [requestId, setRequestId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const lock = useRef(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(
      () => setCooldown((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [cooldown]);
  useEffect(() => {
    if (requestId) codeInput.current?.focus();
  }, [requestId]);
  const send = async () => {
    const result = await api<{ ok: boolean; requestId: string }>(
      mode === "signup"
        ? "/api/register"
        : mode === "reset"
          ? "/api/email/request-reset"
          : "/api/email/link",
      "POST",
      {
        email,
        ...(mode === "signup"
          ? { password }
          : mode === "link"
            ? { currentPassword: password }
            : {}),
      },
    );
    if (!result.ok || !/^[A-Za-z0-9_-]{43}$/.test(result.requestId))
      throw new Error("The request could not be confirmed. Try again.");
    setRequestId(result.requestId);
    setCode("");
    setCooldown(60);
  };
  return (
    <>
      {mode !== "link" && (
        <>
          <span className="eyebrow">
            {mode === "signup" ? "YOUR PRIVATE LIBRARY" : "PASSWORD RECOVERY"}
          </span>
          <h1>
            {mode === "signup" ? "Make a little room." : "Find your way back."}
          </h1>
        </>
      )}
      <p className="muted">
        {mode === "signup"
          ? "Verify your email to create your private library."
          : mode === "link"
            ? "Add a verified email for sign-in and password recovery. Your existing username will keep working."
            : "Reset your password using your verified email. Resetting signs out every browser and disconnects connected apps."}
      </p>
      {requestId && (
        <p role="status" className="settings-notice">
          {mode === "reset"
            ? "If this email belongs to an account, a code is on its way."
            : "If this email is available, a verification code is on its way. Already registered? Sign in or reset your password."}{" "}
          Codes expire in ten minutes. Check your spam folder too.
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current || disabled) return;
          if (
            (mode === "signup" || (mode === "reset" && requestId)) &&
            password !== confirmation
          ) {
            setError("The passwords do not match.");
            return;
          }
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            if (!requestId) await send();
            else {
              const result = await api<{ ok: boolean }>(
                `/api/email/${mode === "signup" ? "verify-signup" : mode === "reset" ? "reset-password" : "verify-link"}`,
                "POST",
                {
                  requestId,
                  code,
                  ...(mode === "signup"
                    ? { password }
                    : mode === "reset"
                      ? { newPassword: password }
                      : { currentPassword: password }),
                },
              );
              if (!result.ok)
                throw new Error(
                  "The action could not be confirmed. Try again.",
                );
              setPassword("");
              setConfirmation("");
              setCode("");
              onComplete(email);
            }
          } catch (error) {
            setError(message(error));
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset className="security-fields" disabled={busy || disabled}>
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              required
              readOnly={Boolean(requestId)}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {requestId && (
            <label>
              Verification code
              <input
                ref={codeInput}
                name="verificationCode"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <span className="field-note">
                Enter the six-digit code from your email.
              </span>
            </label>
          )}
          {mode === "link" ? (
            <label>
              Current password
              <input
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                required
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          ) : (
            (mode === "signup" || requestId) && (
              <NewPasswordFields
                password={password}
                confirmation={confirmation}
                onPassword={setPassword}
                onConfirmation={setConfirmation}
              />
            )
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="actions">
            {onCancel && (
              <button type="button" onClick={onCancel}>
                Back to sign in
              </button>
            )}
            <button type="submit" className="primary">
              {busy && <LoaderCircle className="spin" size={17} />}
              {requestId
                ? mode === "reset"
                  ? "Reset password"
                  : "Verify email"
                : "Send verification code"}
            </button>
          </div>
          {requestId && (
            <button
              type="button"
              disabled={cooldown > 0}
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                setError("");
                try {
                  await send();
                } catch (error) {
                  setError(message(error));
                } finally {
                  lock.current = false;
                  setBusy(false);
                }
              }}
            >
              {cooldown > 0
                ? `Resend available in ${cooldown}s`
                : "Resend code"}
            </button>
          )}
        </fieldset>
      </form>
    </>
  );
}
