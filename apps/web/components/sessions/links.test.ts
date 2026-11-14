import { expect, test } from "vitest";
import { displayTitle } from "./links";

test("displayTitle keeps the first line, decodes entities and clips", () => {
  expect(displayTitle(undefined)).toBeUndefined();
  expect(displayTitle("  \n\n ")).toBeUndefined();
  expect(displayTitle("Fix the build")).toBe("Fix the build");
  expect(displayTitle("\nbuild a tracker\n- add&#x20;login\n- more")).toBe("build a tracker");
  expect(displayTitle("plan&#x20;for &amp; mobile &unknown;")).toBe("plan for & mobile &unknown;");
  const long = displayTitle("x".repeat(300), 20)!;
  expect(long).toHaveLength(20);
  expect(long.endsWith("…")).toBe(true);
});
