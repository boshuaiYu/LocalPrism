import { useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import { DEFAULT_SKILL_PACKS } from "@/lib/default-skill-packs";

const PHASE_MAP: Record<string, number> = {
  "Preparing installer": 4,
  "Checking directory permissions...": 5,
  "Directory permissions OK": 10,
  "Git available": 15,
  "cloning repository": 20,
  "Downloading skills": 20,
  "downloading tarball": 20,
  "Download complete": 60,
  "Copying skills": 70,
  Copied: 90,
  "Cleanup complete": 95,
};

const PACK_IDS = DEFAULT_SKILL_PACKS.map((pack) => pack.id);

function pctFromLog(log: string): number | null {
  const downloadMatch = log.match(/^Download progress\s+(\d+)%/i);
  if (downloadMatch?.[1]) {
    const downloadPct = Math.max(0, Math.min(100, Number(downloadMatch[1])));
    return Math.round(20 + downloadPct * 0.4);
  }

  const downloadedMatch = log.match(/^Downloaded\s+(\d+)\s+MiB/i);
  if (downloadedMatch?.[1]) {
    const mib = Math.max(0, Number(downloadedMatch[1]));
    return Math.min(55, 20 + mib);
  }

  for (const [key, pct] of Object.entries(PHASE_MAP)) {
    if (log.toLowerCase().includes(key.toLowerCase())) return pct;
  }
  return null;
}

function packAwareProgress(logs: readonly string[]): number {
  const packCount = Math.max(PACK_IDS.length, 1);
  let packIndex = 0;
  let downloadPct: number | null = null;
  let downloadedMib = 0;
  let sawDownloadComplete = false;
  let sawCopied = false;

  for (const log of logs) {
    const updating = log.match(/^Updating\s+([a-z0-9-]+)/i);
    if (updating?.[1]) {
      const index = PACK_IDS.indexOf(updating[1] as (typeof PACK_IDS)[number]);
      if (index >= 0 && index !== packIndex) {
        packIndex = index;
        downloadPct = null;
        downloadedMib = 0;
        sawDownloadComplete = false;
        sawCopied = false;
      }
    }
    const downloadMatch = log.match(/^Download progress\s+(\d+)%/i);
    if (downloadMatch?.[1]) {
      downloadPct = Math.max(0, Math.min(100, Number(downloadMatch[1])));
    }
    const mibMatch = log.match(/^Downloaded\s+(\d+)\s+MiB/i);
    if (mibMatch?.[1]) {
      downloadedMib = Math.max(downloadedMib, Number(mibMatch[1]));
    }
    if (/download complete/i.test(log)) sawDownloadComplete = true;
    if (/\bcopied\b/i.test(log)) sawCopied = true;
  }

  const start = Math.round((packIndex / packCount) * 88);
  const span = Math.max(8, Math.round(88 / packCount));
  let pct = start + 6;
  if (downloadPct !== null) {
    pct = Math.max(
      pct,
      start + 6 + Math.round((downloadPct / 100) * (span - 8)),
    );
  } else if (downloadedMib > 0) {
    pct = Math.max(pct, Math.min(start + span - 4, start + 6 + downloadedMib));
  }
  if (sawDownloadComplete) pct = Math.max(pct, start + span - 4);
  if (sawCopied) pct = Math.max(pct, start + span - 1);
  return Math.min(99, pct);
}

export function progressFromInstallLogs(
  logs: readonly string[],
  isComplete = false,
): number {
  if (isComplete) return 100;
  if (logs.some((log) => /^Updating\s+/i.test(log))) {
    return packAwareProgress(logs);
  }
  return logs.reduce((current, line) => {
    const next = pctFromLog(line);
    return next === null ? current : Math.max(current, next);
  }, 0);
}

interface InstallProgressProps {
  isInstalling: boolean;
  isComplete: boolean;
  error: string | null;
  logs: string[];
}

export function InstallProgress({
  isComplete,
  error,
  logs,
}: InstallProgressProps) {
  const pct = useMemo(
    () => progressFromInstallLogs(logs, isComplete),
    [isComplete, logs],
  );

  const label = isComplete
    ? "Done"
    : error
      ? "Error"
      : logs.length > 0
        ? logs[logs.length - 1]
        : "Starting...";

  return (
    <div className="space-y-2 py-1">
      <Progress value={pct} />
      <div className="flex items-center justify-between">
        <p className="max-w-[80%] truncate text-muted-foreground text-xs">
          {label}
        </p>
        <p className="font-mono text-muted-foreground text-xs tabular-nums">
          {pct}%
        </p>
      </div>
    </div>
  );
}
