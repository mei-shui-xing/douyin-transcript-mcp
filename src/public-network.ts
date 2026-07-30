import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const DEFAULT_MAX_REDIRECTS = 5;
const MAX_DOH_RESPONSE_BYTES = 128 * 1024;
const DOH_TIMEOUT_MS = 8_000;
const DOH_CACHE_TTL_MS = 60_000;
const dohCache = new Map<string, { expiresAt: number; addresses: PublicNetworkLookupResult[] }>();

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
const globallyRoutableIpv6Addresses = new BlockList();
globallyRoutableIpv6Addresses.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
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
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export type PublicNetworkLookupResult = {
  address: string;
  family: number;
};

export type PublicNetworkDependencies = {
  fetch?: typeof globalThis.fetch;
  lookup?: (hostname: string) => Promise<PublicNetworkLookupResult[]>;
};

export type PublicFetchPolicy = {
  allowedHostSuffixes?: readonly string[];
  maxRedirects?: number;
};

function normalizedHostname(hostname: string): string {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unwrapped.toLowerCase();
}

function hostMatchesAllowedSuffix(hostname: string, suffix: string): boolean {
  const normalizedSuffix = suffix.toLowerCase().replace(/^\.+|\.+$/g, "");
  return hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`);
}

export function assertSafePublicHttpsUrl(
  rawUrl: string | URL,
  allowedHostSuffixes?: readonly string[],
): URL {
  let parsed: URL;
  try {
    parsed = new URL(typeof rawUrl === "string" ? rawUrl : rawUrl.href);
  } catch {
    throw new Error("PUBLIC_URL_INVALID");
  }
  if (parsed.protocol !== "https:") throw new Error("PUBLIC_URL_HTTPS_REQUIRED");
  if (parsed.username || parsed.password) throw new Error("PUBLIC_URL_USERINFO_FORBIDDEN");
  if (parsed.port) throw new Error("PUBLIC_URL_CUSTOM_PORT_FORBIDDEN");
  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname || hostname.endsWith(".")) throw new Error("PUBLIC_URL_HOST_INVALID");
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new Error("PUBLIC_URL_PRIVATE_IP_FORBIDDEN");
  }
  if (allowedHostSuffixes?.length
    && !allowedHostSuffixes.some(suffix => hostMatchesAllowedSuffix(hostname, suffix))) {
    throw new Error("PUBLIC_URL_HOST_NOT_ALLOWED");
  }
  parsed.hash = "";
  return parsed;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4Addresses.check(address, "ipv4");
  if (family === 6) {
    return globallyRoutableIpv6Addresses.check(address, "ipv6")
      && !blockedIpv6Addresses.check(address, "ipv6");
  }
  return false;
}

function isClashFakeIpAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 198 && (second === 18 || second === 19);
}

function queryPinnedCloudflareDoh(hostname: string, recordType: "A" | "AAAA"): Promise<PublicNetworkLookupResult[]> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      host: "1.1.1.1",
      port: 443,
      family: 4,
      servername: "cloudflare-dns.com",
      method: "GET",
      path: `/dns-query?name=${encodeURIComponent(hostname)}&type=${recordType}`,
      headers: {
        Host: "cloudflare-dns.com",
        Accept: "application/dns-json",
        "User-Agent": "douyin-transcript-network-policy/1",
      },
    }, response => {
      response.on("error", reject);
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("PUBLIC_DOH_HTTP_FAILED"));
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_DOH_RESPONSE_BYTES) {
          response.destroy(new Error("PUBLIC_DOH_BODY_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            Status?: number;
            Answer?: Array<{ type?: number; data?: string }>;
          };
          if (payload.Status !== 0) throw new Error("PUBLIC_DOH_QUERY_FAILED");
          const expectedType = recordType === "A" ? 1 : 28;
          const expectedFamily = recordType === "A" ? 4 : 6;
          resolve((payload.Answer ?? [])
            .filter(answer => answer.type === expectedType && isIP(String(answer.data ?? "")) === expectedFamily)
            .map(answer => ({ address: String(answer.data), family: expectedFamily })));
        } catch {
          reject(new Error("PUBLIC_DOH_RESPONSE_INVALID"));
        }
      });
    });
    request.setTimeout(DOH_TIMEOUT_MS, () => request.destroy(new Error("PUBLIC_DOH_TIMEOUT")));
    request.on("error", reject);
    request.end();
  });
}

async function lookupThroughPinnedDoh(hostname: string): Promise<PublicNetworkLookupResult[]> {
  const cached = dohCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;
  const results = await Promise.allSettled([
    queryPinnedCloudflareDoh(hostname, "A"),
    queryPinnedCloudflareDoh(hostname, "AAAA"),
  ]);
  const addresses = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
  if (!addresses.length) throw new Error("PUBLIC_DOH_NO_RESULTS");
  const unique = [...new Map(addresses.map(result => [result.address, result])).values()];
  dohCache.set(hostname, { expiresAt: Date.now() + DOH_CACHE_TTL_MS, addresses: unique });
  return unique;
}

async function defaultLookup(hostname: string): Promise<PublicNetworkLookupResult[]> {
  const systemAddresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (systemAddresses.length && systemAddresses.every(result => isClashFakeIpAddress(result.address))) {
    return lookupThroughPinnedDoh(hostname);
  }
  return systemAddresses;
}

export async function assertOnlyPublicDnsResults(
  url: URL,
  dependencies: PublicNetworkDependencies = {},
): Promise<void> {
  await resolveOnlyPublicDnsResults(url, dependencies);
}

async function resolveOnlyPublicDnsResults(
  url: URL,
  dependencies: PublicNetworkDependencies,
): Promise<PublicNetworkLookupResult[]> {
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new Error("PUBLIC_DNS_PRIVATE_ADDRESS_FORBIDDEN");
    return [{ address: hostname, family: isIP(hostname) }];
  }
  let addresses: PublicNetworkLookupResult[];
  try {
    addresses = await (dependencies.lookup ?? defaultLookup)(hostname);
  } catch {
    throw new Error("PUBLIC_DNS_LOOKUP_FAILED");
  }
  if (!addresses.length) throw new Error("PUBLIC_DNS_NO_RESULTS");
  if (addresses.some(result => !isPublicIpAddress(result.address))) {
    throw new Error("PUBLIC_DNS_PRIVATE_ADDRESS_FORBIDDEN");
  }
  return addresses;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isSensitiveCrossOriginHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  if ([
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
    "api-key",
    "x-api-key",
    "x-mcp-access-token",
    "x-auth-token",
    "x-access-token",
    "x-csrf-token",
    "x-xsrf-token",
  ].includes(normalized)) return true;
  return normalized.startsWith("x-")
    && /(?:^|-)(?:auth(?:orization)?|token|secret|credential|signature|api-key|access-key)(?:-|$)/.test(normalized);
}

function headersAfterCrossOriginRedirect(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const name of [...sanitized.keys()]) {
    if (isSensitiveCrossOriginHeader(name)) sanitized.delete(name);
  }
  return sanitized;
}

function decodedResponseBody(message: Readable, contentEncoding: string): Readable {
  const encoding = contentEncoding.trim().toLowerCase();
  if (!encoding || encoding === "identity") return message;
  if (encoding === "gzip" || encoding === "x-gzip") return message.pipe(createGunzip());
  if (encoding === "deflate") return message.pipe(createInflate());
  if (encoding === "br") return message.pipe(createBrotliDecompress());
  message.destroy();
  throw new Error("PUBLIC_CONTENT_ENCODING_UNSUPPORTED");
}

async function pinnedHttpsFetch(
  url: URL,
  init: RequestInit,
  addresses: PublicNetworkLookupResult[],
): Promise<Response> {
  const method = String(init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new Error("PUBLIC_FETCH_METHOD_FORBIDDEN");
  const selected = addresses.find(result => isIP(result.address) === 4) ?? addresses[0];
  const selectedFamily = isIP(selected.address);
  if (selectedFamily !== 4 && selectedFamily !== 6) throw new Error("PUBLIC_DNS_RESULT_INVALID");
  const requestHeaders = new Headers(init.headers);
  requestHeaders.delete("host");
  requestHeaders.delete("connection");

  return new Promise<Response>((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers: Object.fromEntries(requestHeaders.entries()),
      signal: init.signal ?? undefined,
      servername: normalizedHostname(url.hostname),
      family: selectedFamily,
      lookup: (_hostname, _options, callback) => {
        callback(null, selected.address, selectedFamily);
      },
    }, message => {
      try {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(message.headers)) {
          if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item));
          else if (value != null) responseHeaders.set(name, value);
        }
        const status = message.statusCode ?? 502;
        const bodyForbidden = method === "HEAD" || status === 204 || status === 205 || status === 304;
        const decoded = bodyForbidden
          ? null
          : decodedResponseBody(message, responseHeaders.get("content-encoding") ?? "");
        if (decoded !== message) {
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }
        const response = new Response(
          decoded ? Readable.toWeb(decoded) as ReadableStream<Uint8Array> : null,
          {
            status,
            statusText: message.statusMessage,
            headers: responseHeaders,
          },
        );
        Object.defineProperty(response, "url", { value: url.href, configurable: true });
        resolve(response);
      } catch (error) {
        message.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    request.end();
  });
}

export async function fetchPublicHttpsWithRedirects(
  rawUrl: string | URL,
  init: RequestInit,
  policy: PublicFetchPolicy = {},
  dependencies: PublicNetworkDependencies = {},
): Promise<Response> {
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("PUBLIC_REDIRECT_LIMIT_INVALID");
  }
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  let current = assertSafePublicHttpsUrl(rawUrl, policy.allowedHostSuffixes);
  let requestHeaders = new Headers(init.headers);

  for (let redirectCount = 0; ; redirectCount += 1) {
    const addresses = await resolveOnlyPublicDnsResults(current, dependencies);
    const requestInit = { ...init, headers: requestHeaders };
    let response: Response;
    try {
      response = dependencies.fetch
        ? await fetchImpl(current, { ...requestInit, redirect: "manual" })
        : await pinnedHttpsFetch(current, requestInit, addresses);
    } catch {
      throw new Error("PUBLIC_FETCH_FAILED");
    }
    if (!isRedirectStatus(response.status)) return response;
    if (redirectCount >= maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("PUBLIC_REDIRECT_LIMIT_EXCEEDED");
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error("PUBLIC_REDIRECT_LOCATION_MISSING");
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error("PUBLIC_REDIRECT_LOCATION_INVALID");
    }
    const validatedNext = assertSafePublicHttpsUrl(next, policy.allowedHostSuffixes);
    if (validatedNext.origin !== current.origin) {
      requestHeaders = headersAfterCrossOriginRedirect(requestHeaders);
    }
    current = validatedNext;
  }
}

export async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("PUBLIC_BODY_LIMIT_INVALID");
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) throw new Error("PUBLIC_RESPONSE_BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
}
