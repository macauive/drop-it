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
    await tx.query(
      "DELETE FROM rate_limit_counters WHERE window_start < now()-interval '1 day'",
    );
    await tx.query(
      "DELETE FROM page_captures WHERE created_at < now()-interval '24 hours'",
    );
    await tx.query(
      "DELETE FROM email_outbox WHERE expires_at < now()-interval '7 days'",
    );
    await tx.query("DELETE FROM email_challenges WHERE expires_at < now()");
    await tx.query(
      "DELETE FROM email_request_limits WHERE last_at < now()-interval '1 day'",
    );
    await tx.query("DELETE FROM chatgpt_pending WHERE expires_at < now()");
    await tx.query("DELETE FROM sessions WHERE expires_at < now()");
    await tx.query("DELETE FROM oauth_pending WHERE expires_at < now()");
    await tx.query("DELETE FROM oauth_codes WHERE expires_at < now()");
    // A rotated token's hash remains evidence of replay for as long as a
    // successor refresh token can keep the same family alive.
    await tx.query(`DELETE FROM oauth_tokens expired WHERE expires_at < now()
      AND (kind <> 'refresh_used' OR NOT EXISTS (
        SELECT 1 FROM oauth_tokens active WHERE active.family=expired.family
        AND active.owner=expired.owner AND active.client_id=expired.client_id
        AND active.kind='refresh' AND active.expires_at>now()
      ))`);
    // Preserve in-flight consent/code flows as well as every token family.
    // Missing/invalid issue timestamps are retained rather than guessed.
    await tx.query(`DELETE FROM oauth_clients c
      WHERE c.last_used_at < now()-interval '90 days'
      AND CASE WHEN jsonb_typeof(c.data->'client_id_issued_at')='number'
        THEN (c.data->>'client_id_issued_at')::numeric < extract(epoch FROM now()-interval '90 days')
        ELSE false END
      AND NOT EXISTS(SELECT 1 FROM oauth_tokens t WHERE t.client_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM oauth_pending p WHERE p.client_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM oauth_codes a WHERE a.client_id=c.id)`);
    // Abandoned uploads get a grace period; sources in use are never collected.
    await tx.query(`DELETE FROM attachments a WHERE created_at < now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.owner=a.owner AND s.attachment_id=a.id)`);
  });
}
