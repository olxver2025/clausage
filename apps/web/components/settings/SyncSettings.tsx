"use client";

import { Button } from "@ui-sdk/react/button";
import { FileInput, FileInputTrigger } from "@ui-sdk/react/file-input";
import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useState, useTransition } from "react";
import { saveMachineName, savePublish, saveSyncFolder, setUpSyncKey, syncNow, type ActionResult } from "@/app/actions";
import { SettingRow } from "./SettingRow";

export interface SyncSettingsProps {
  keyPath: string | null;
  machineName: string;
  folder: string;
  publish: boolean;
}

export function SyncSettings({ keyPath, machineName, folder, publish }: SyncSettingsProps) {
  const [name, setName] = useState(machineName);
  const [dir, setDir] = useState(folder);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<ActionResult>) =>
    new Promise<void>((resolve) => {
      startTransition(async () => {
        const r = await action();
        setResult(r);
        resolve();
      });
    });

  return (
    <>
      <div className="px-4 py-4 text-xs leading-relaxed text-fg-2">
        <h3 className="mb-2 text-sm font-medium text-fg">Set up sync</h3>
        <ol className="list-decimal space-y-1.5 pl-4">
          <li>Create a sync key on the first computer. Transfer its key file privately, then choose Import key on each other computer. Keep the file outside the shared drive.</li>
          <li>Create a folder inside iCloud Drive, Dropbox, Syncthing or a shared network drive. Make sure it is available on every computer.</li>
          <li>Enter the path to that existing folder below and save it. Give this computer a recognizable name.</li>
          <li>On each other computer, open clausage and repeat these steps using the same shared folder. Its local path may be different.</li>
          <li>Wait for your folder service to transfer the files, then check the computer list below or select Sync now.</li>
        </ol>
        <p className="mt-2 text-fg-3">clausage encrypts usage counts and metadata on this computer before sharing them. Your folder service handles transferring the files.</p>
      </div>
      <SettingRow title="Sync encryption key" stacked description={keyPath ? "To pair another computer, transfer this file privately and import it there." : "Create a key for a new group of computers, or import the key from an existing group."}>
        {keyPath ? (
          <code className="break-all text-xs">{keyPath}</code>
        ) : (
          <>
            <Button disabled={pending} onClick={() => run(() => setUpSyncKey())}>Create key</Button>
            <FileInput aria-label="Sync key file" disabled={pending} maxSize={128}
              onReject={() => setResult({ ok: false, error: "Choose a clausage sync key file." })}
              onValueChange={([file]) => {
                if (!file) return;
                const upload = new FormData();
                upload.set("key", file);
                void run(() => setUpSyncKey(upload));
              }}
            >
              <FileInputTrigger>Import key</FileInputTrigger>
            </FileInput>
          </>
        )}
      </SettingRow>
      <SettingRow title="This computer" htmlFor="machine-name" description="The name your other computers show for usage recorded here.">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => saveMachineName(name));
          }}
        >
          <Input id="machine-name" value={name} onValueChange={setName} maxLength={64} className="w-44" autoComplete="off" />
          <Button type="button" disabled={name.trim() === machineName || !name.trim()} onClick={() => run(() => saveMachineName(name))}>
            Rename
          </Button>
        </form>
      </SettingRow>
      <SettingRow
        title="Sync folder"
        htmlFor="sync-folder"
        stacked
        description={
          <>
            Enter the full path to the existing shared folder on this computer, for example ~/Dropbox/clausage. Create the folder first if it does not exist.
          </>
        }
      >
        <form
          className="flex w-full max-w-[34rem] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => saveSyncFolder(dir));
          }}
        >
          <Input
            id="sync-folder"
            value={dir}
            onValueChange={setDir}
            placeholder="~/Dropbox/clausage"
            className="min-w-0 flex-1 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="button" disabled={dir.trim() === folder} onClick={() => run(() => saveSyncFolder(dir))}>
            {dir.trim() || !folder ? "Save" : "Turn off"}
          </Button>
        </form>
      </SettingRow>
      {folder && (
        <SettingRow title="Share this computer’s usage" description="Turn off to only view the other computers from here.">
          <Switch aria-label="Share this computer’s usage" checked={publish} onCheckedChange={(v) => void run(() => savePublish(v))}>
            <SwitchThumb />
          </Switch>
        </SettingRow>
      )}
      {result && (
        <p role="status" className={`settings-note ${result.ok ? "text-fg-2" : "text-critical"}`}>
          {result.ok ? result.message : result.error}
        </p>
      )}
    </>
  );
}

export function SyncNowButton() {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-3">
      {result && !result.ok && (
        <span role="status" className="text-xs text-critical">
          {result.error}
        </span>
      )}
      <Button
        className="button-primary"
        pendingAnnouncement="Syncing"
        onClick={() =>
          new Promise<void>((resolve) => {
            startTransition(async () => {
              setResult(await syncNow());
              resolve();
            });
          })
        }
      >
        Sync now
      </Button>
    </div>
  );
}
