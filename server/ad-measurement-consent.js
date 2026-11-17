(() => {
  const panel = document.getElementById("ad-measurement");
  if (!panel || navigator.globalPrivacyControl || location.protocol !== "https:") return;
  const cookie = "__Host-oai-ad-measurement";
  const choice = document.getElementById("ad-measurement-choice");
  const stop = document.getElementById("stop-ad-measurement");
  const references = new URLSearchParams(location.search).getAll("oppref");
  const reference = references.length === 1 && /^[A-Za-z0-9_.=-]{1,1500}$/.test(references[0]) ? references[0] : null;
  const hasAttribution = () => document.cookie.split(";").some(part => part.trim().startsWith(cookie + "="));

  stop.hidden = !hasAttribution();
  choice.hidden = !reference || !stop.hidden;
  panel.hidden = stop.hidden && choice.hidden;
  document.getElementById("allow-ad-measurement").addEventListener("click", () => {
    if (!reference) return;
    document.cookie = cookie + "=" + crypto.randomUUID() + "~" + reference + "; Path=/; Secure; SameSite=Lax; Max-Age=604800";
    choice.hidden = true;
    stop.hidden = !hasAttribution();
    panel.hidden = stop.hidden;
  });
  document.getElementById("skip-ad-measurement").addEventListener("click", () => { panel.hidden = true; });
  stop.addEventListener("click", () => {
    document.cookie = cookie + "=; Path=/; Secure; SameSite=Lax; Max-Age=0";
    panel.hidden = true;
  });
})();
