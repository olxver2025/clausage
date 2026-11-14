import type { ToolId } from "@clausage/core";

export function sessionHref(tool: ToolId, sessionId: string, query = ""): string {
  return `/sessions/${tool}/${encodeURIComponent(sessionId)}${query}`;
}

export function shortId(id: string): string {
  const clean = id.replace(/^ses_/, "");
  return clean.length > 10 ? clean.slice(0, 8) : clean;
}

export function baseName(path: string): string {
  if (!path) return "(unknown)";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * A session title for display: HTML entities decoded, first non-empty line only, clipped.
 * Some tools title a thread with its whole first prompt; this keeps only a short label of it.
 */
export function displayTitle(title: string | undefined | null, max = 100): string | undefined {
  if (!title) return undefined;
  const decoded = title.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
  const line = (decoded.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
