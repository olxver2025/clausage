import type { NextRequest } from "next/server";
import { EXPORT_CONTENT_TYPES, eventsToDelimited, reportToDelimited, type CacheGroup, type DelimitedFormat, type ReportKind } from "@clausage/core";
import { cacheEfficiencyFor, getCodexRateLimits, getInsights, getLimitStatus, getReport, getSourcesSummary, getUsage, type ReportOptions } from "@/lib/data";
import { parseFilters } from "@/lib/filters";

const KINDS: readonly ReportKind[] = ["daily", "weekly", "monthly", "session", "blocks", "models", "projects", "tools"];
const EXTRA_KINDS = ["sources", "limits", "events", "cache", "insights"] as const;
const FORMATS: readonly DelimitedFormat[] = ["csv", "tsv", "jsonl"];
const CACHE_GROUPS: readonly CacheGroup[] = ["total", "model", "tool", "day", "session"];

function delimited(body: string, format: DelimitedFormat, name: string): Response {
  const ext = format === "jsonl" ? "jsonl" : format;
  return new Response(body, {
    headers: { "content-type": EXPORT_CONTENT_TYPES[format], "content-disposition": `inline; filename="clausage-${name}.${ext}"` },
  });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const kind = params.get("kind") ?? "daily";
  const filters = parseFilters(params);
  const formatParam = params.get("format");
  if (formatParam && formatParam !== "json" && !(FORMATS as readonly string[]).includes(formatParam)) {
    return Response.json({ error: `Unknown format "${formatParam}". Use json, ${FORMATS.join(", ")}` }, { status: 400 });
  }
  const format = formatParam && formatParam !== "json" ? (formatParam as DelimitedFormat) : undefined;

  if (kind === "sources") return Response.json(await getSourcesSummary());
  if (kind === "limits") {
    const [codex, status] = await Promise.all([getCodexRateLimits(filters.fresh), getLimitStatus(filters)]);
    return Response.json({ codex, tools: status.tools, now: status.now, timezone: status.timezone });
  }
  if (kind === "events") {
    const data = await getUsage(filters);
    const events = params.get("order") === "desc" ? [...data.events].reverse() : data.events;
    if (format) return delimited(eventsToDelimited(events, format), format, "events");
    return Response.json({ events: JSON.parse(`[${eventsToDelimited(events, "jsonl").trim().split("\n").filter(Boolean).join(",")}]`), filters });
  }
  if (kind === "cache") {
    const group = (params.get("group") ?? "model") as CacheGroup;
    if (!CACHE_GROUPS.includes(group)) return Response.json({ error: `group must be one of ${CACHE_GROUPS.join(", ")}` }, { status: 400 });
    const data = await getUsage(filters);
    return Response.json({ group, total: cacheEfficiencyFor(data, "total")[0] ?? null, rows: cacheEfficiencyFor(data, group), filters });
  }
  if (kind === "insights") return Response.json({ ...(await getInsights(filters)), filters });
  if (!(KINDS as readonly string[]).includes(kind)) {
    return Response.json(
      { error: `Unknown kind "${kind}". Use one of: ${[...KINDS, ...EXTRA_KINDS].join(", ")}` },
      { status: 400 },
    );
  }

  const opts: ReportOptions = {};
  const order = params.get("order");
  if (order === "asc" || order === "desc") opts.order = order;
  if (params.get("breakdown") === "0") opts.breakdown = false;
  const len = Number(params.get("sessionLength"));
  if (Number.isFinite(len) && len > 0) opts.sessionLengthHours = len;

  try {
    const report = await getReport(kind as ReportKind, filters, opts);
    if (format) return delimited(reportToDelimited(report, format, { breakdown: params.get("breakdown") === "1" }), format, kind);
    return Response.json({ ...report, filters });
  } catch (err) {
    return Response.json({ error: (err as Error).message ?? String(err) }, { status: 500 });
  }
}
