"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useFilterQuery } from "./navigation";

export const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/sessions", label: "Sessions" },
  { href: "/models", label: "Models" },
  { href: "/projects", label: "Projects" },
  { href: "/blocks", label: "Blocks & limits" },
  { href: "/settings", label: "Settings" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks() {
  const pathname = usePathname();
  const query = useFilterQuery();
  const listRef = useRef<HTMLUListElement>(null);

  // On narrow screens the nav scrolls sideways; keep the current page's link in view.
  useEffect(() => {
    const list = listRef.current;
    const nav = list?.parentElement;
    const link = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !link || nav.scrollWidth <= nav.clientWidth) return;
    const n = nav.getBoundingClientRect();
    const r = link.getBoundingClientRect();
    if (r.right > n.right) nav.scrollLeft += r.right - n.right + 16;
    else if (r.left < n.left) nav.scrollLeft -= n.left - r.left + 16;
  }, [pathname]);

  return <NavList pathname={pathname} query={query} listRef={listRef} />;
}

export function NavLinksFallback() {
  return <NavList pathname="" query="" />;
}

function NavList({ pathname, query, listRef }: { pathname: string; query: string; listRef?: React.Ref<HTMLUListElement> }) {
  return (
    <ul ref={listRef} className="nav-list">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link href={`${item.href}${query}`} aria-current={active ? "page" : undefined} className="nav-link">
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
