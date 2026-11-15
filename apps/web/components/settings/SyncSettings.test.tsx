import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, expect, test, vi } from "vitest";
import { installedSyncKeyPath } from "@clausage/core";
import { SyncSettings } from "./SyncSettings";

vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/lib/data", () => ({ clearUsageCache: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

test("create on one dashboard and import the same key on another", async () => {
  const root = mkdtempSync(join(tmpdir(), "clausage-web-key-"));
  try {
    const props = { machineName: "Computer", folder: "", publish: true, keyPath: null };
    vi.stubEnv("CLAUSAGE_CONFIG_DIR", join(root, "first"));
    const agent = createAgent();
    const first = render(<SyncSettings {...props} />);
    await act(async () => {});
    expect(agent.snapshot().map((entry) => entry.label)).toContain("Create key");
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Create key" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByText("Sync key created.");
    const path = installedSyncKeyPath()!;
    const key = readFileSync(path, "utf8");
    first.rerender(<SyncSettings {...props} keyPath={path} />);
    expect(screen.getByText(path)).toBeTruthy();
    expect(screen.queryByText(key.trim())).toBeNull();
    expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
    first.unmount();

    vi.stubEnv("CLAUSAGE_CONFIG_DIR", join(root, "second"));
    const second = render(<SyncSettings {...props} />);
    const picker = second.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(picker, { target: { files: [new File(["invalid"], "bad.key")] } });
    await screen.findByText(/Invalid sync.key/);
    expect(installedSyncKeyPath()).toBeNull();
    fireEvent.change(picker, { target: { files: [new File([key], "sync.key")] } });
    await screen.findByText("Sync key imported.");
    expect(readFileSync(installedSyncKeyPath()!, "utf8")).toBe(key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
