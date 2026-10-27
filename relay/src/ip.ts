// Rate-limit key for an address. An IPv6 host usually gets a whole /64, so the /64 is what's counted.
export function limitKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip; // IPv4 (or IPv4-mapped): the address itself
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
