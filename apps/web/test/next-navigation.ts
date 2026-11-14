import { vi } from "vitest";

/** A stand-in for next/navigation whose URL tests can set and whose router records replace() calls. */
export const nav = {
  pathname: "/",
  params: new URLSearchParams(),
  replace: vi.fn((href: string) => {
    const q = href.split("?")[1] ?? "";
    nav.params = new URLSearchParams(q);
  }),
  reset(query = "") {
    nav.pathname = "/";
    nav.params = new URLSearchParams(query);
    nav.replace.mockClear();
  },
};

export const nextNavigationMock = {
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.params,
  useRouter: () => ({ replace: nav.replace, push: nav.replace, refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
};
