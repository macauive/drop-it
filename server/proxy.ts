import { BlockList, isIP } from "node:net";

// Cloudflare's published proxy networks, checked 2026-11-16. Review updates at
// https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/.
// Never fetch trust configuration from a request or a runtime network response.
const cloudflare = new BlockList();
for (const subnet of [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
]) {
  const [address, prefix] = subnet.split("/");
  cloudflare.addSubnet(
    address,
    Number(prefix),
    isIP(address) === 4 ? "ipv4" : "ipv6",
  );
}

export function proxyTrust(hops = 0, trustCloudflare = false) {
  if (!trustCloudflare) return hops;
  if (hops !== 1)
    throw new Error("TRUST_CLOUDFLARE_PROXY requires TRUST_PROXY_HOPS=1");
  // The managed ingress must append/replace XFF with its actual peer. For a
  // shorter direct path that peer is the client and must stop traversal. Even
  // through Cloudflare, stop after its one allowlisted hop; never trust a
  // client-supplied leftmost value, CF-Connecting-IP or X-Real-IP.
  return (address: string, index: number) => {
    if (index === 0) return true;
    if (index !== 1) return false;
    const family = isIP(address);
    return (
      family !== 0 && cloudflare.check(address, family === 4 ? "ipv4" : "ipv6")
    );
  };
}
