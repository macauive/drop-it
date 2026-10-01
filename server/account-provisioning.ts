import { randomUUID } from "node:crypto";
import { newPasswordSchema, usernameSchema } from "../shared/schema.js";
import { hashPassword } from "./auth.js";
import type { Database } from "./db.js";

export class AccountProvisioningError extends Error {}

// Administrative access only: never expose this helper through an HTTP route.
// Creates an empty account without enabling signup or issuing sessions/tokens.
export async function provisionAccount(
  db: Database,
  inputUsername: string,
  password: string,
) {
  const parsedUsername = usernameSchema.safeParse(inputUsername);
  if (!parsedUsername.success || parsedUsername.data === "owner")
    throw new AccountProvisioningError(
      "Choose a valid, non-reserved username.",
    );
  if (!newPasswordSchema.safeParse(password).success)
    throw new AccountProvisioningError("Password must be 15–128 characters.");
  const username = parsedUsername.data;
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      "INSERT INTO users(id,singleton,username,password_hash) VALUES($1,NULL,$2,$3) ON CONFLICT(username) DO NOTHING RETURNING id",
      [randomUUID(), username, hash],
    );
    if (!rows.length)
      throw new AccountProvisioningError(
        "Username is already in use; nothing changed.",
      );
  });
}
