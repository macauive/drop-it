import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Auth } from "./auth.js";
import type { Library } from "./library.js";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import {
  fieldsSchema,
  idSchema,
  urlSchema,
  categorySchema,
  usernameSchema,
  draftSchema,
} from "../shared/schema.js";
import { extensionOrigin } from "../shared/extension.js";

// Only capture is exposed here: no arbitrary source IDs, uploads, exports,
// account changes, or owner identifiers supplied by the extension.
export const extensionCaptureSchema = fieldsSchema
  .extend({
    requestId: idSchema,
    // A safety precondition, never an authority to select an owner.
    accountId: idSchema,
    source: z
      .object({
        originalText: z.string().max(50000),
        url: urlSchema,
        retrievalId: idSchema.optional(),
      })
      .strict(),
    allowDuplicate: z.boolean().default(false),
  })
  .strict();

export function addExtensionRoutes(
  app: express.Express,
  auth: Auth,
  library: Library,
  config: Config,
) {
  const origins = new Set(
    config.redirectUris.map(extensionOrigin).filter(Boolean),
  );
  const router = express.Router();
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );
  router.use(async (req, res, next) => {
    const origin = req.headers.origin;
    // Chrome may omit Origin on privileged GETs. Bearer credentials remain
    // mandatory and are bound below to an explicitly enabled extension client.
    if (origin && !origins.has(origin))
      throw new AppError(
        403,
        "ORIGIN",
        "This extension is not enabled on this Drop It server.",
      );
    res.setHeader("Vary", "Origin");
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS") {
      if (!origin) throw new AppError(403, "ORIGIN", "Origin is required.");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      res.sendStatus(204);
      return;
    }
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization ?? "",
    );
    if (!bearer)
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Connect your Drop It account.",
      );
    let info;
    try {
      info = await auth.verifyAccessToken(bearer[1]);
    } catch {
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Reconnect your Drop It account.",
      );
    }
    // An allowed extension origin alone is insufficient. Its token must belong
    // to a client registered for that exact extension, with capture permission.
    const client = await auth.clientsStore.getClient(info.clientId);
    const clientOrigin =
      client?.redirect_uris.length === 1
        ? extensionOrigin(client.redirect_uris[0])
        : undefined;
    if (
      !clientOrigin ||
      !origins.has(clientOrigin) ||
      (origin && clientOrigin !== origin) ||
      !info.scopes.includes("capture:write")
    )
      throw new AppError(403, "SCOPE", "This connection cannot capture drops.");
    res.locals.owner = String(info.extra.owner);
    next();
  });
  router.get("/connection", async (req, res) => {
    if (Object.keys(req.query).length)
      throw new AppError(400, "VALIDATION", "Unexpected connection fields.");
    const { rows } = await auth.db.query<{
      id: string;
      username: string | null;
    }>("SELECT id,username FROM users WHERE id=$1", [res.locals.owner]);
    const user = rows[0];
    if (!user)
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Reconnect your Drop It account.",
      );
    const id = idSchema.parse(user.id);
    res.json({
      connected: true,
      account: {
        id,
        label: user.username
          ? `@${usernameSchema.parse(user.username)}`
          : `Account ${id.slice(0, 8)}`,
      },
    });
  });
  router.get("/suggestions", async (req, res) => {
    if (Object.keys(req.query).length)
      throw new AppError(400, "VALIDATION", "Unexpected suggestion fields.");
    // Bounded metadata only. Capture credentials cannot search or read items.
    const pools = await auth.db.query<{ category: string }>(
      "SELECT category FROM items WHERE owner=$1 AND trashed_at IS NULL GROUP BY category ORDER BY count(*) DESC,category LIMIT 100",
      [res.locals.owner],
    );
    const tags = await auth.db.query<{ tag: string }>(
      "SELECT tag FROM items CROSS JOIN LATERAL unnest(tags) AS tag WHERE owner=$1 AND trashed_at IS NULL GROUP BY tag ORDER BY count(*) DESC,tag LIMIT 200",
      [res.locals.owner],
    );
    res.json({
      accountId: res.locals.owner,
      pools: pools.rows.map((row) => categorySchema.parse(row.category)),
      tags: tags.rows.map((row) =>
        z.string().trim().min(1).max(40).parse(row.tag),
      ),
    });
  });
  router.post("/draft", express.json({ limit: "350kb" }), async (req, res) => {
    const { accountId, source } = z
      .object({
        accountId: idSchema,
        source: z
          .object({ originalText: z.string().max(50000), url: urlSchema })
          .strict(),
      })
      .strict()
      .parse(req.body);
    if (accountId !== res.locals.owner)
      throw new AppError(
        409,
        "ACCOUNT_CHANGED",
        "This capture belongs to another account. Start a new capture.",
      );
    const result = await library.draft(
      res.locals.owner,
      draftSchema.parse({ source, fetchPage: true }),
    );
    res.json({ accountId, ...result });
  });
  router.post(
    "/capture",
    express.json({ limit: "350kb" }),
    async (req, res) => {
      const { accountId, ...capture } = extensionCaptureSchema.parse(req.body);
      if (accountId !== res.locals.owner)
        throw new AppError(
          409,
          "ACCOUNT_CHANGED",
          "This capture belongs to another account. Start a new capture.",
        );
      const result = await library.save(res.locals.owner, capture);
      // Do not return the owner's preserved source or unrelated library metadata.
      res.status(result.replayed ? 200 : 201).json({
        id: result.item.id,
        title: result.item.title,
        replayed: result.replayed,
      });
    },
  );
  app.use("/extension/v1", router);
}
