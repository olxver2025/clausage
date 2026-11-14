import type { NextRequest } from "next/server";
import type { ReportKind } from "@clausage/core";
import { getCodexRateLimits, getReport, getSourcesSummary, type ReportOptions } from "@/lib/data";
import { parseFilters } from "@/lib/filters";

const KINDS: readonly ReportKind[] = ["daily", "weekly", "monthly", "session", "blocks", "models", "projects", "tools"];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const kind = params.get("kind") ?? "daily";
  const filters = parseFilters(params);

  if (kind === "sources") return Response.json(await getSourcesSummary());
  if (kind === "limits") return Response.json({ codex: await getCodexRateLimits(filters.fresh) });
  if (!(KINDS as readonly string[]).includes(kind)) {
    return Response.json(
      { error: `Unknown kind "${kind}". Use one of: ${[...KINDS, "sources", "limits"].join(", ")}` },
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
    return Response.json({ ...report, filters });
  } catch (err) {
    return Response.json({ error: (err as Error).message ?? String(err) }, { status: 500 });
  }
}
