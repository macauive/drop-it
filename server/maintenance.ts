import type { Database } from "./db.js";

export async function cleanupExpired(db: Database) {
  // Use the same owner locks as create, edit, restore and export.
  const owners = await db.query<{ owner: string }>(
    "SELECT DISTINCT owner FROM items WHERE trashed_at <= now()-interval '7 days'",
  );
  for (const { owner } of owners.rows) {
    await db.transaction(async (tx) => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
      const expired = await tx.query<{ source_id: string }>(
        "DELETE FROM items WHERE owner=$1 AND trashed_at <= now()-interval '7 days' RETURNING source_id",
        [owner],
      );
      const sources = await tx.query<{ attachment_id: string | null }>(
        `DELETE FROM sources s WHERE s.owner=$1 AND s.id=ANY($2::uuid[])
        AND NOT EXISTS(SELECT 1 FROM items i WHERE i.owner=s.owner AND i.source_id=s.id) RETURNING attachment_id`,
        [owner, expired.rows.map((row) => row.source_id)],
      );
      await tx.query(
        `DELETE FROM attachments a WHERE a.owner=$1 AND a.id=ANY($2::uuid[])
        AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.owner=a.owner AND s.attachment_id=a.id)`,
        [
          owner,
          sources.rows.flatMap((row) =>
            row.attachment_id ? [row.attachment_id] : [],
          ),
        ],
      );
    });
  }
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
