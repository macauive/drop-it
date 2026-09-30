import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { z } from "zod";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import { Auth } from "./auth.js";
import { Library } from "./library.js";
import { createMcpServer } from "./mcp.js";
import { AppError } from "./errors.js";
import { searchSchema, idSchema } from "../shared/schema.js";

export function createApp(db: Database, config: Config, html: string) {
  const app = express();
  const auth = new Auth(db, config),
    library = new Library(db);
  const cookie = config.local ? "drop_it_session" : "__Host-drop_it_session";
  const cookieOptions = {
    httpOnly: true,
    secure: !config.local,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 7 * 86400000,
  };
  const scripts = [
    ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
  ].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
  );
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...scripts],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: config.local ? null : [],
        },
      },
      strictTransportSecurity: config.local ? false : undefined,
    }),
  );
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(config.origin).host) {
      res.status(400).json({ error: "Unexpected host." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(cookieParser());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(
    mcpAuthRouter({
      provider: auth,
      issuerUrl: new URL(config.origin),
      resourceServerUrl: new URL(auth.resource),
      scopesSupported: ["library:read", "library:write"],
      resourceName: "Drop It",
    }),
  );
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Too many requests. Please wait a minute." },
    }),
  );
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin !== config.origin
    ) {
      res.status(403).json({ error: "Request origin was not accepted." });
      return;
    }
    next();
  });
  app.use("/api", express.json({ limit: "100kb" }));
  const loginLimiter = rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Please try again later." },
  });
  const passwordSchema = z
    .object({ password: z.string().min(12).max(128) })
    .strict();
  app.get("/api/session", async (req, res) => {
    const owner = await auth.sessionOwner(req.cookies[cookie]);
    res.json({
      authenticated: Boolean(owner),
      needsSetup: !(await auth.hasOwner()),
      localSetup: config.local,
    });
  });
  app.post("/api/setup", loginLimiter, async (req, res) => {
    const address = req.socket.remoteAddress;
    if (
      !config.local ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")
    )
      throw new AppError(
        403,
        "LOCAL_ONLY",
        "Create the owner account locally before exposing Drop It.",
      );
    const { password } = passwordSchema.parse(req.body);
    res
      .cookie(cookie, await auth.setup(password), cookieOptions)
      .json({ ok: true });
  });
  app.post("/api/login", loginLimiter, async (req, res) => {
    const { password } = passwordSchema.parse(req.body);
    res
      .cookie(cookie, await auth.login(password), cookieOptions)
      .json({ ok: true });
  });
  app.use("/api", async (req, res, next) => {
    const owner = await auth.sessionOwner(req.cookies[cookie]);
    if (!owner)
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Sign in to open your library.",
      );
    res.locals.owner = owner;
    next();
  });
  app.post("/api/logout", async (req, res) => {
    await auth.logout(req.cookies[cookie]);
    res
      .clearCookie(cookie, { ...cookieOptions, maxAge: undefined })
      .json({ ok: true });
  });
  app.post("/api/revoke-connections", async (_req, res) => {
    await auth.revokeAll(res.locals.owner);
    res.json({ ok: true });
  });
  app.get("/api/authorize/:id", async (req, res) =>
    res.json(
      await auth.pending(z.string().min(20).max(100).parse(req.params.id)),
    ),
  );
  app.post("/api/authorize/:id", async (req, res) => {
    const { approved } = z
      .object({ approved: z.boolean() })
      .strict()
      .parse(req.body);
    res.json(
      await auth.consent(
        res.locals.owner,
        z.string().min(20).max(100).parse(req.params.id),
        approved,
      ),
    );
  });
  app.post(
    "/api/attachments",
    express.raw({
      type: ["image/png", "image/jpeg", "image/webp"],
      limit: "10mb",
    }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body))
        throw new AppError(
          400,
          "INVALID_IMAGE",
          "Choose a PNG, JPEG, or WebP image.",
        );
      res
        .status(201)
        .json(
          await library.upload(
            res.locals.owner,
            req.body,
            req.headers["content-type"] ?? "",
          ),
        );
    },
  );
  app.get("/api/sources/:id/image", async (req, res) => {
    const image = await library.image(
      res.locals.owner,
      idSchema.parse(req.params.id),
    );
    res.type(image.mime).send(image.bytes);
  });
  app.post("/api/search", async (req, res) =>
    res.json(
      await library.search(res.locals.owner, searchSchema.parse(req.body)),
    ),
  );
  app.post("/api/items", async (req, res) =>
    res.status(201).json(await library.save(res.locals.owner, req.body)),
  );
  app.get("/api/items/:id", async (req, res) =>
    res.json(
      await library.get(res.locals.owner, idSchema.parse(req.params.id)),
    ),
  );
  app.patch("/api/items/:id", async (req, res) => {
    if (!req.body || typeof req.body !== "object" || "id" in req.body)
      throw new AppError(400, "INVALID_REQUEST", "Invalid update.");
    res.json(
      await library.update(res.locals.owner, {
        ...req.body,
        id: idSchema.parse(req.params.id),
      }),
    );
  });
  app.delete("/api/items/:id", async (req, res) => {
    const body = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    res.json(
      await library.delete(res.locals.owner, {
        ...body,
        id: idSchema.parse(req.params.id),
      }),
    );
  });
  app.get("/api/export", async (_req, res) => {
    res
      .attachment("drop-it-library.json")
      .json(await library.export(res.locals.owner));
  });
  app.post(
    "/mcp",
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
    express.json({ limit: "150kb" }),
    async (req, res) => {
      if (
        req.headers.origin &&
        ![config.origin, "https://chatgpt.com"].includes(req.headers.origin)
      )
        throw new AppError(403, "ORIGIN", "Origin not allowed.");
      let owner: string | undefined;
      let scopes: string[] = [];
      if (req.headers.authorization) {
        try {
          const header = z
            .string()
            .regex(/^Bearer [A-Za-z0-9_-]{43}$/)
            .parse(req.headers.authorization);
          const info = await auth.verifyAccessToken(header.slice(7));
          owner = String(info.extra.owner);
          scopes = info.scopes;
        } catch {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
          );
          res.status(401).json({ error: "Reconnect your Drop It account." });
          return;
        }
      }
      const server = createMcpServer(library, config, html, owner, scopes);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );
  app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());
  app.get("/", (_req, res) => res.type("html").send(html));
  app.use((_req, res) => res.status(404).json({ error: "Not found." }));
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      void _next;
      if (res.headersSent) return;
      if (error instanceof AppError) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code, ...error.details });
        return;
      }
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({
            error: "Some fields are invalid. Check their format and length.",
            code: "VALIDATION",
          });
        return;
      }
      const status = (error as { status?: number })?.status;
      if (status === 413) {
        res.status(413).json({ error: "The upload is too large." });
        return;
      }
      if (status === 400) {
        res.status(400).json({ error: "Invalid request body." });
        return;
      }
      console.error("Request failed", { code: "INTERNAL_ERROR" });
      res.status(500).json({ error: "Something went wrong. Please retry." });
    },
  );
  return { app, auth, library };
}
