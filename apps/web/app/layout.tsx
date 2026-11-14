import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { AgentBridge } from "@/components/shell/AgentBridge";
import { AppPreferences } from "@/components/shell/AppPreferences";
import { FilterBar, FilterBarFallback } from "@/components/shell/FilterBar";
import { NavigationProvider, PendingRegion } from "@/components/shell/navigation";
import { NavLinks, NavLinksFallback } from "@/components/shell/NavLinks";
import { SourcesFooter, SourcesFooterFallback } from "@/components/shell/SourcesFooter";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "clausage", template: "%s · clausage" },
  description: "Local usage, cost and limits for agentic coding tools.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f3" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body>
        <AppPreferences>
          <NavigationProvider>
            <a href="#content" className="skip-link">
              Skip to content
            </a>
            <div className="app-shell">
              <aside className="app-sidebar">
                <div className="flex items-center justify-between gap-3 lg:block">
                  <Link href="/" className="brand">
                    clausage
                  </Link>
                  <ThemeToggle className="lg:hidden" />
                </div>
                <nav aria-label="Main" className="app-nav">
                  <Suspense fallback={<NavLinksFallback />}>
                    <NavLinks />
                  </Suspense>
                </nav>
                <div className="mt-auto hidden lg:block">
                  <ThemeToggle />
                </div>
              </aside>
              <div className="app-main">
                <header className="app-header">
                  <Suspense fallback={<FilterBarFallback />}>
                    <FilterBar />
                  </Suspense>
                </header>
                <PendingRegion className="flex-1">
                  <main id="content" tabIndex={-1} className="app-content">
                    {children}
                  </main>
                </PendingRegion>
                <footer className="app-footer">
                  <Suspense fallback={<SourcesFooterFallback />}>
                    <SourcesFooter />
                  </Suspense>
                </footer>
              </div>
            </div>
            <Suspense fallback={null}>
              <AgentBridge />
            </Suspense>
          </NavigationProvider>
        </AppPreferences>
      </body>
    </html>
  );
}
