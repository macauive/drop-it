export function NewPasswordFields({
  password,
  confirmation,
  onPassword,
  onConfirmation,
}: {
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
}) {
  return (
    <>
      <label>
        New password
        <input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          minLength={15}
          maxLength={128}
          required
          value={password}
          onChange={(event) => onPassword(event.target.value)}
        />
        <span className="field-note">
          Use at least 15 characters. A unique passphrase works well.
        </span>
      </label>
      <label>
        Confirm new password
        <input
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          minLength={15}
          maxLength={128}
          required
          value={confirmation}
          onChange={(event) => onConfirmation(event.target.value)}
        />
      </label>
    </>
  );
}
