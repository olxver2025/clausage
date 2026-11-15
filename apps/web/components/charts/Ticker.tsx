"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { formatValue, type ValueFormat } from "@/lib/format";
import { useSettings } from "@/lib/settings";

export interface TickerProps {
  value: number;
  /** a named formatter: client components can't take formatter functions from server components */
  format?: ValueFormat;
  className?: string;
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * A number that rolls its digits, odometer style, when the value changes (e.g. on a live refresh).
 * Columns are keyed from the right so place values stay put while the string grows. The first
 * render is static, so navigating between pages doesn't animate; reduced motion turns the roll off.
 * Screen readers get the plain text.
 */
export function Ticker({ value, format = "compact", className = "" }: TickerProps) {
  const text = formatValue(value, format);
  const { animateNumbers } = useSettings();
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before === value || !Number.isFinite(before) || !Number.isFinite(value)) return;
    setDir(value > before ? "up" : "down");
    const t = setTimeout(() => setDir(null), 1400);
    return () => clearTimeout(t);
  }, [value]);

  if (!animateNumbers) return <span className={`tabular ${className}`}>{text}</span>;
  const chars = [...text];
  return (
    <span className={`ticker ${className}`} data-dir={dir ?? undefined}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="ticker-face">
        {chars.map((ch, i) => {
          const fromRight = chars.length - i;
          const d = DIGITS.indexOf(ch);
          if (d < 0) {
            return (
              <span key={`s${fromRight}`} className="ticker-sym">
                {ch}
              </span>
            );
          }
          return (
            <span key={`d${fromRight}`} className="ticker-col" style={{ "--d": d, "--i": fromRight } as CSSProperties}>
              <span className="ticker-strip">
                {DIGITS.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
