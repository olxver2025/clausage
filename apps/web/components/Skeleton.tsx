export function PanelSkeleton({ height = 240, label = "Loading usage…", className = "" }: { height?: number; label?: string; className?: string }) {
  return (
    <div role="status" className={`panel grid place-items-center text-xs text-fg-3 ${className}`} style={{ height }}>
      {label}
    </div>
  );
}
