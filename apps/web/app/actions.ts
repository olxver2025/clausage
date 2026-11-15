"use server";

import { refresh } from "next/cache";
import { installSyncKey, importSyncKeyText, saveClaudeUsageConfig, saveLimitConfig, saveSyncConfig, type ToolId, type ToolLimitConfig } from "@clausage/core";
import { clearUsageCache, publishSnapshot } from "@/lib/data";

export async function refreshUsage(): Promise<void> {
  clearUsageCache();
  refresh();
}

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export async function setUpSyncKey(upload?: FormData): Promise<ActionResult> {
  try {
    if (upload === undefined) {
      installSyncKey();
    } else {
      const file = upload.get("key");
      if (!(file instanceof File) || file.size > 128) {
        return { ok: false, error: "Choose a clausage sync key file." };
      }
      importSyncKeyText(await file.text());
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      refresh();
      return { ok: false, error: "This computer already has a sync key." };
    }
    return { ok: false, error: (err as Error).message };
  }
  clearUsageCache();
  refresh();
  return { ok: true, message: upload ? "Sync key imported." : "Sync key created." };
}

/** Rename this computer as other computers see it. */
export async function saveMachineName(name: string): Promise<ActionResult> {
  try {
    saveSyncConfig({ machineName: String(name ?? "").slice(0, 64) });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  clearUsageCache();
  refresh();
  return { ok: true };
}

/** Set (or with "" clear) the shared sync folder, then publish this computer's snapshot into it. */
export async function saveSyncFolder(folder: string): Promise<ActionResult> {
  const value = String(folder ?? "").trim();
  try {
    saveSyncConfig({ folder: value || null });
    clearUsageCache();
    if (value) {
      const status = await publishSnapshot();
      if (status.warnings.length) {
        refresh();
        return { ok: false, error: status.warnings[0]! };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  refresh();
  return { ok: true, message: value ? "Sync folder saved." : "Sync turned off." };
}

/** Whether this computer writes its own snapshot (off = read-only viewer of the others). */
export async function savePublish(publish: boolean): Promise<ActionResult> {
  try {
    saveSyncConfig({ publish: Boolean(publish) });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  clearUsageCache();
  refresh();
  return { ok: true };
}

export async function syncNow(): Promise<ActionResult> {
  try {
    clearUsageCache();
    const status = await publishSnapshot();
    if (status.warnings.length) return { ok: false, error: status.warnings[0]! };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  refresh();
  return { ok: true, message: "Synced." };
}

/** Save one tool's usage limits (5-hour and weekly token limits, weekly reset). */
export async function saveToolLimits(tool: ToolId, config: ToolLimitConfig | null): Promise<ActionResult> {
  try {
    saveLimitConfig(tool, config);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  clearUsageCache();
  refresh();
  return { ok: true, message: "Saved." };
}

/** Turn the opt-in fetch of Claude's real limits (with the Claude Code login) on or off. */
export async function setClaudeUsage(enabled: boolean): Promise<ActionResult> {
  try {
    saveClaudeUsageConfig({ enabled: Boolean(enabled) });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  clearUsageCache();
  refresh();
  return { ok: true, message: enabled ? "On. Blocks & limits now shows Claude’s real limits." : "Off." };
}
