import type { Database } from "./db.js";

export async function cleanupExpired(db: Database) {
  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM sessions WHERE expires_at < now()");
    await tx.query("DELETE FROM oauth_pending WHERE expires_at < now()");
    await tx.query("DELETE FROM oauth_codes WHERE expires_at < now()");
    await tx.query("DELETE FROM oauth_tokens WHERE expires_at < now()");
    // Abandoned uploads get a grace period; sources in use are never collected.
    await tx.query(`DELETE FROM attachments a WHERE created_at < now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.owner=a.owner AND s.attachment_id=a.id)`);
  });
}
