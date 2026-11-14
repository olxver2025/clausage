export interface SparklineProps {
  values: number[];
  /** accessible name, e.g. "Daily cost, last 30 days" */
  label: string;
  width?: number;
  height?: number;
  /** stroke color; defaults to the de-emphasis ink */
  color?: string;
  /** end-dot on the latest value, in the accent color */
  markLast?: boolean;
  /** washed area under the line */
  area?: boolean;
  className?: string;
}

export function Sparkline({ values, label, width = 96, height = 28, color = "var(--text-3)", markLast = true, area = false, className = "" }: SparklineProps) {
  const pad = 3;
  if (values.length < 2) {
    return <svg role="img" aria-label={`${label}: not enough data`} width={width} height={height} className={className} />;
  }
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => [pad + i * step, pad + (height - pad * 2) * (1 - (v - min) / span)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const last = pts[pts.length - 1]!;
  const base = height - pad;
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`block overflow-visible ${className}`}>
      {area && <path d={`${d}L${last[0].toFixed(1)},${base}L${pts[0]![0].toFixed(1)},${base}Z`} fill={color} opacity={0.1} />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {markLast && <circle cx={last[0]} cy={last[1]} r={2.75} fill="var(--accent)" stroke="var(--surface)" strokeWidth={1.5} />}
    </svg>
  );
}
