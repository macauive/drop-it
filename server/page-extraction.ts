import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { pageSnapshotSchema, type PageSnapshot } from "../shared/page.js";
import { AppError } from "./errors.js";

export interface PageExtractor {
  extract(url: string): Promise<PageSnapshot>;
}
const unavailable = () =>
  new AppError(
    502,
    "PAGE_FAILED",
    "Page retrieval could not complete. Keep the link or enter details manually.",
  );
const invalid = () =>
  new AppError(
    400,
    "PAGE_URL",
    "Retrieve a public article or documentation page without private addresses, sign-in links, or secret parameters. You can still save the link manually.",
  );
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix);
const blockedV6 = new BlockList();
blockedV6.addSubnet("2001::", 23, "ipv6");
blockedV6.addSubnet("2001:db8::", 32, "ipv6");
blockedV6.addSubnet("2002::", 16, "ipv6");
blockedV6.addSubnet("3fff::", 20, "ipv6");
export function publicAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address);
  // Global unicast only; reject transition, documentation and special ranges.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !blockedV6.check(address, "ipv6")
  );
}
export function publicPageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.hash &&
    /(?:token|secret|key|signature|credential|code|password)=/i.test(url.hash)
  )
    throw invalid();
  if (
    value.length > 2048 ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char === "\\") ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    /(?:^|\.)(localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(
      host,
    ) ||
    host === "metadata.google.internal"
  )
    throw invalid();
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw invalid();
  }
  if (
    /(?:^|\/)(?:login|logout|signin|sign-in|oauth|auth|account|admin|private|internal|reset-password|verify|invite)(?:\/|$)/i.test(
      path,
    ) ||
    /[A-Za-z0-9_=-]{64,}/.test(path) ||
    /%[0-9a-f]{2}/i.test(path)
  )
    throw invalid();
  for (const [key, val] of url.searchParams) {
    if (
      !/^(?:page|p|lang|hl|version|v|ref|utm_(?:source|medium|campaign|content|term))$/i.test(
        key,
      ) ||
      !/^[\p{L}\p{N} ._-]{0,80}$/u.test(val)
    )
      throw invalid();
  }
  url.hostname = host;
  url.hash = ""; // Fragments stay in the original, never go to the provider.
  return url;
}
export type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;
const resolvePublic = async (
  url: URL,
  resolver: Resolver,
  signal: AbortSignal,
) => {
  const addresses = await Promise.race([
    resolver(url.hostname),
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(unavailable());
      else
        signal.addEventListener("abort", () => reject(unavailable()), {
          once: true,
        });
    }),
  ]);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw invalid();
  return addresses[0];
};
type Head = (
  url: URL,
  address: { address: string; family: number },
  signal: AbortSignal,
) => Promise<{ status: number; location?: string; contentType: string }>;
const head: Head = (url, address, signal) =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "HEAD",
        signal,
        agent: false,
        family: address.family,
        // Pin the already checked DNS answer, including at every redirect hop.
        lookup: (_host, _options, cb) =>
          cb(null, address.address, address.family),
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "DropIt-PageCapture/1.0",
        },
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          contentType: res.headers["content-type"] ?? "",
        });
        res.destroy();
      },
    );
    req.on("error", reject);
    req.end();
  });
export async function preflightPage(
  value: string,
  signal: AbortSignal,
  resolver: Resolver = (host) => lookup(host, { all: true }),
  transport: Head = head,
) {
  let url = publicPageUrl(value);
  for (let hop = 0; hop < 5; hop++) {
    signal.throwIfAborted();
    const address = await resolvePublic(url, resolver, signal);
    const result = await transport(url, address, signal);
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (!result.location) throw unavailable();
      const next = publicPageUrl(new URL(result.location, url).href);
      if (url.protocol === "https:" && next.protocol !== "https:")
        throw invalid();
      url = next;
      continue;
    }
    if (
      result.status !== 200 ||
      !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
        result.contentType,
      )
    )
      throw unavailable();
    return url;
  }
  throw unavailable();
}
export class FirecrawlExtractor implements PageExtractor {
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
    private readonly preflight = preflightPage,
  ) {}
  async extract(value: string): Promise<PageSnapshot> {
    try {
      const signal = AbortSignal.timeout(15000);
      const url = await this.preflight(value, signal);
      const response = await this.transport(
        "https://api.firecrawl.dev/v2/scrape",
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: url.href,
            formats: ["markdown"],
            onlyMainContent: true,
            onlyCleanContent: false,
            parsers: [],
            timeout: 10000,
            maxAge: 0,
            storeInCache: false,
            proxy: "basic",
            removeBase64Images: true,
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if ([402, 429].includes(response.status))
          throw new AppError(
            429,
            "PAGE_LIMIT",
            "Page retrieval has reached its usage limit. Keep the link or enter details manually.",
          );
        throw unavailable();
      }
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          bytes += chunk.length;
          if (bytes > 512 * 1024) throw unavailable();
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
      }
      const data = z
        .object({
          success: z.literal(true),
          data: z.object({
            markdown: z
              .string()
              .min(1)
              .max(512 * 1024),
            metadata: z.object({
              url: z.string().max(2048),
              sourceURL: z.string().max(2048).optional(),
              statusCode: z.literal(200),
              contentType: z.string().max(200),
              title: z.string().max(10000).optional(),
              description: z.string().max(20000).optional(),
              error: z.string().optional(),
            }),
          }),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data;
      // Fail closed on an unexpected provider redirect, MIME or error page.
      if (
        publicPageUrl(data.metadata.url).href !== url.href ||
        (data.metadata.sourceURL &&
          publicPageUrl(data.metadata.sourceURL).href !== url.href) ||
        data.metadata.error ||
        !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
          data.metadata.contentType,
        )
      )
        throw unavailable();
      return pageSnapshotSchema.parse({
        provider: "firecrawl",
        requestedUrl: value,
        finalUrl: url.href,
        capturedAt: new Date().toISOString(),
        title: (data.metadata.title ?? "").slice(0, 200),
        description: (data.metadata.description ?? "").slice(0, 2000),
        text: data.markdown.slice(0, 30000),
        truncated: data.markdown.length > 30000,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unavailable();
    }
  }
}
