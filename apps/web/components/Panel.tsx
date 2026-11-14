import type { ReactNode } from "react";

export interface PanelProps {
  title: string;
  /** short line under the title */
  description?: ReactNode;
  /** controls on the right of the header */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** heading level for the title (default 2) */
  level?: 2 | 3;
}

export function Panel({ title, description, actions, children, className = "", level = 2 }: PanelProps) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <section className={`panel min-w-0 p-3 sm:p-4 ${className}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <H className="text-sm font-semibold">{title}</H>
          {description && <p className="mt-0.5 text-xs text-fg-3">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1>{title}</h1>
        {description && <p className="mt-0.5 text-xs text-fg-3">{description}</p>}
      </div>
      {children}
    </div>
  );
}
