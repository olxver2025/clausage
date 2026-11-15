import type { ReactNode } from "react";

/** One setting: name and explanation on the left, its control on the right (stacked on narrow screens). */
export function SettingRow({ title, description, htmlFor, stacked, children }: { title: string; description?: ReactNode; htmlFor?: string; /** control on its own line, full width */ stacked?: boolean; children: ReactNode }) {
  const Title = htmlFor ? "label" : "div";
  return (
    <div className="setting-row" data-stacked={stacked ? "" : undefined}>
      <div className="min-w-0">
        <Title {...(htmlFor ? { htmlFor } : {})} className="block text-sm font-medium text-fg">
          {title}
        </Title>
        {description && <p className="mt-0.5 max-w-[34rem] text-xs leading-relaxed text-pretty text-fg-3">{description}</p>}
      </div>
      <div className={`flex min-w-0 items-center gap-2 ${stacked ? "" : "sm:justify-end"}`}>{children}</div>
    </div>
  );
}

export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="settings-section">
      <header>
        <h2 id={`${id}-heading`} className="text-sm font-semibold">
          {title}
        </h2>
        {description && <p className="mt-0.5 max-w-[40rem] text-xs leading-relaxed text-pretty text-fg-3">{description}</p>}
      </header>
      <div className="settings-card">{children}</div>
    </section>
  );
}
