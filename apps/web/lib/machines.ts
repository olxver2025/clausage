import type { MachineInfo } from "@clausage/core";

/** Machine names in display order (this computer first), or [] when only one computer is in the data. */
export function machineGroups(machines: readonly MachineInfo[] | undefined, present: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const m of present) seen.add(m ?? "");
  if (seen.size < 2) return [];
  const ordered = (machines ?? []).map((m) => m.name).filter((n) => seen.has(n));
  for (const n of seen) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

export function machineLabel(machines: readonly MachineInfo[] | undefined, name: string): string {
  if (!name) return "Unknown computer";
  return machines?.find((m) => m.name === name)?.local ? `${name} (this computer)` : name;
}
