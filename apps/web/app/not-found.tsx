import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/Panel";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" description="Nothing matches this address. The session may be outside the scanned data, or the link is out of date." />
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/sessions" className="text-fg-2 underline underline-offset-2 hover:text-fg">
          All sessions
        </Link>
        <Link href="/" className="text-fg-2 underline underline-offset-2 hover:text-fg">
          Overview
        </Link>
      </div>
    </>
  );
}
