const SOURCE_URL = "https://dontdropit.app/about";
const COOKIE = "__Host-oai-ad-measurement";
const VALUE = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})~([A-Za-z0-9_.=-]{1,1500})$/i;

type Settings = { pixelId?: string; apiKey?: string };
type Event = "registration_completed" | "lead_created";

export function adMeasurementEnabled({ pixelId, apiKey }: Settings) {
  return Boolean(pixelId && /^[A-Za-z0-9_-]{1,100}$/.test(pixelId) && apiKey);
}

export function adMeasurementReference(cookie: string | null | undefined, gpc: string | null | undefined) {
  if (gpc === "1" || !cookie) return;
  const values = cookie.split(";").map(value => value.trim()).filter(value => value.startsWith(COOKIE + "="));
  if (values.length !== 1) return;
  const reference = VALUE.exec(values[0].slice(COOKIE.length + 1));
  if (reference) return { id: reference[1], oppref: reference[2] };
}

export async function reportAdConversion(
  settings: Settings,
  reference: ReturnType<typeof adMeasurementReference>,
  type: Event,
  fetcher = fetch,
) {
  if (!reference || !settings.pixelId || !adMeasurementEnabled(settings)) return;
  const url = new URL("https://bzr.openai.com/v1/events");
  url.searchParams.set("pid", settings.pixelId);
  try {
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(1200),
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{
        id: reference.id, oppref: reference.oppref, type, timestamp_ms: Date.now(),
        source_url: SOURCE_URL, action_source: "web", data: { type: "customer_action" },
      }] }),
    });
    await response.body?.cancel();
    if (!response.ok) console.warn("Ad conversion delivery failed.");
  } catch {
    console.warn("Ad conversion delivery failed.");
  }
}
