const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

export function decodeHtml(value: string): string {
  return value
    .replace(/&(amp|quot|#39|apos|lt|gt|nbsp);/gi, (match) => HTML_ENTITIES[match.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeCandidate(value: string): string {
  return stripTags(value)
    .replace(/[|｜].*$/u, "")
    .replace(/\s+[-–—]\s+[^-–—]{1,35}$/u, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function slugKeyword(url: string): string {
  const parsed = new URL(url);
  const pieces = parsed.pathname.split("/").filter(Boolean);
  const last = pieces.at(-1) ?? "";
  try {
    return normalizeCandidate(decodeURIComponent(last));
  } catch {
    return normalizeCandidate(last);
  }
}

export function buildKeywordCandidates(
  url: string,
  title: string,
  h1: string,
): string[] {
  const values = [slugKeyword(url), normalizeCandidate(title), normalizeCandidate(h1)];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const value of values) {
    if (!value || value.length < 3 || value.length > 100 || seen.has(value)) continue;
    seen.add(value);
    candidates.push(value);
  }

  return candidates.slice(0, 3);
}

export function googleTrendsUrl(keyword: string): string {
  const query = encodeURIComponent(keyword);
  return `https://trends.google.com/trends/explore?date=today%205-y&q=${query}`;
}
