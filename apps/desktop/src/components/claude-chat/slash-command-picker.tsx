import {
  type FC,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  CommandIcon,
  FolderOpenIcon,
  GlobeIcon,
  TerminalIcon,
  FileCodeIcon,
  ZapIcon,
  XIcon,
  SearchIcon,
  FlaskConicalIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  groupItemsBySkillCategory,
  skillFolderFromSlashCommand,
  type CatalogSkillCategory,
} from "@/lib/skill-categories";
import { SKILLS_LIST_UPDATED_EVENT } from "@/lib/skills-refresh";
import { useI18n } from "@/lib/use-i18n";
import { useSkillCategoryStore } from "@/stores/skill-category-store";

export interface SlashCommand {
  id: string;
  name: string;
  full_command: string;
  scope: string;
  namespace: string | null;
  file_path: string;
  content: string;
  description: string | null;
  allowed_tools: string[];
  has_bash_commands: boolean;
  has_file_references: boolean;
  accepts_arguments: boolean;
  category?: string | null;
}

interface SlashCommandPickerProps {
  projectPath: string | null;
  query: string;
  anchorRef: RefObject<HTMLDivElement | null>;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

type Tab = "skills" | "default" | "custom";

const SCOPE_LABEL: Record<string, string> = {
  skill: "Skill",
  default: "Default",
  project: "Project",
  user: "User",
};

function scopeToTab(scope: string): Tab {
  if (scope === "skill") return "skills";
  if (scope === "default") return "default";
  return "custom";
}

function getCommandIcon(command: SlashCommand) {
  if (command.scope === "skill")
    return (
      <FlaskConicalIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  if (command.has_bash_commands)
    return <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.has_file_references)
    return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.scope === "project")
    return (
      <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  if (command.scope === "user")
    return <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.scope === "default")
    return <CommandIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

// ─── Fuzzy matching (fzf/fzy-inspired) ───

const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_MATCH_CONSECUTIVE = 1.0;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;
const SCORE_MAX_LEADING_GAP = -0.05;

function _isWordBoundary(prev: string, curr: string): boolean {
  return (
    prev === "-" ||
    prev === "_" ||
    prev === " " ||
    prev === "/" ||
    prev === "." ||
    (prev === prev.toLowerCase() && curr === curr.toUpperCase())
  );
}

function bonusFor(prev: string, curr: string): number {
  if (prev === "/") return SCORE_MATCH_SLASH;
  if (prev === "-" || prev === "_" || prev === " ") return SCORE_MATCH_WORD;
  if (prev === ".") return SCORE_MATCH_DOT;
  if (prev === prev.toLowerCase() && curr === curr.toUpperCase())
    return SCORE_MATCH_CAPITAL;
  return 0;
}

/** Score query against candidate. Returns -Infinity if no match. */
function fuzzyScore(query: string, candidate: string): number {
  const n = query.length;
  const m = candidate.length;

  if (n === 0) return 0;
  if (n > m) return -Infinity;

  const qLower = query.toLowerCase();
  const cLower = candidate.toLowerCase();

  // Quick check: all query chars exist in candidate in order
  let qi = 0;
  for (let ci = 0; ci < m && qi < n; ci++) {
    if (qLower[qi] === cLower[ci]) qi++;
  }
  if (qi < n) return -Infinity;

  // Score matrix (simplified fzy)
  // D[i][j] = best score ending with query[i] matching candidate[j] consecutively
  // M[i][j] = best score for query[0..i] matching within candidate[0..j]
  const D: number[][] = [];
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    D.push(new Array(m).fill(-Infinity));
    M.push(new Array(m).fill(-Infinity));
  }

  for (let i = 0; i < n; i++) {
    let prevScore = -Infinity;
    const gapScore = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;

    for (let j = 0; j < m; j++) {
      if (qLower[i] === cLower[j]) {
        let score = 0;

        if (i === 0) {
          // First char of query
          score =
            j === 0
              ? SCORE_MATCH_CONSECUTIVE // start of string
              : Math.max(SCORE_MAX_LEADING_GAP, SCORE_GAP_LEADING * j) +
                bonusFor(candidate[j - 1], candidate[j]);
        } else if (j > 0) {
          // Consecutive match bonus
          const consecutive = D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE;
          // Non-consecutive: gap penalty from best previous match
          const boundary =
            M[i - 1][j - 1] + bonusFor(candidate[j - 1], candidate[j]);
          score = Math.max(consecutive, boundary);
        }

        D[i][j] = score;
        M[i][j] = Math.max(score, prevScore + gapScore);
      } else {
        D[i][j] = -Infinity;
        M[i][j] = prevScore + gapScore;
      }

      prevScore = M[i][j];
    }
  }

  return M[n - 1][m - 1];
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  const dp: number[] = Array.from({ length: m + 1 }, (_, i) => i);

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }

  return dp[m];
}

/**
 * Typo-tolerant score: find the best-matching substring of candidate
 * within a window around the query length, then compute edit distance.
 * Handles "bioarxiv" → "biorxiv-database" (matches the "biorxiv" part).
 */
function typoScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const maxDist = Math.max(1, Math.floor(q.length / 3));

  // Slide a window of varying size over the candidate to find the closest substring
  let bestDist = Infinity;
  const minWin = Math.max(1, q.length - maxDist);
  const maxWin = q.length + maxDist;

  for (let winLen = minWin; winLen <= maxWin && winLen <= c.length; winLen++) {
    for (let start = 0; start + winLen <= c.length; start++) {
      const sub = c.slice(start, start + winLen);
      const dist = levenshtein(q, sub);
      if (dist < bestDist) {
        bestDist = dist;
        if (dist === 0) break;
      }
    }
    if (bestDist === 0) break;
  }

  if (bestDist > maxDist) return -Infinity;
  // Score: always below fuzzy matches, closer distance = higher score
  return -0.5 - bestDist * 0.5;
}

/** Score a command against the query, checking multiple fields. */
function scoreCommand(cmd: SlashCommand, q: string): number {
  const cmdKey = cmd.full_command.slice(1); // strip leading /

  // 1. Fuzzy subsequence matching on command key and name (short strings, reliable)
  const cmdScore = fuzzyScore(q, cmdKey);
  const nameScore = fuzzyScore(q, cmd.name);

  // 2. Description: only substring (contains) match to avoid false positives on long text
  let descScore = -Infinity;
  if (cmd.description?.toLowerCase().includes(q.toLowerCase())) {
    descScore = q.length * 0.3; // modest score for description-only match
  }

  const fuzzy = Math.max(cmdScore, nameScore, descScore);
  if (fuzzy > -Infinity) return fuzzy;

  // 3. Typo-tolerant fallback on command key / name (handles bioarxiv → biorxiv)
  const typo = Math.max(typoScore(q, cmdKey), typoScore(q, cmd.name));

  return typo;
}

function filterAndSort(list: SlashCommand[], q: string): SlashCommand[] {
  if (!q) return list;

  const scored: { cmd: SlashCommand; score: number }[] = [];

  for (const cmd of list) {
    const score = scoreCommand(cmd, q);
    if (score > -Infinity) {
      scored.push({ cmd, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => s.cmd);
}

export function commandHasPreview(cmd: SlashCommand): boolean {
  return Boolean(cmd.description?.trim() || cmd.content?.trim());
}

/** Render command / SKILL.md body as lightweight styled content */
function CommandPreview({ content }: { content: string }) {
  // Strip frontmatter
  let body = content;
  if (body.startsWith("---")) {
    const endIdx = body.indexOf("---", 3);
    if (endIdx !== -1) {
      body = body.slice(endIdx + 3).trim();
    }
  }

  return (
    <div className="prose prose-sm prose-invert max-w-none text-muted-foreground text-xs leading-relaxed">
      {body.split("\n").map((line, i) => {
        const trimmed = line.trimEnd();
        if (trimmed.startsWith("# ")) {
          return (
            <h3
              key={i}
              className="mt-3 mb-1 font-semibold text-foreground text-sm"
            >
              {trimmed.slice(2)}
            </h3>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h4
              key={i}
              className="mt-2.5 mb-0.5 font-semibold text-foreground text-xs"
            >
              {trimmed.slice(3)}
            </h4>
          );
        }
        if (trimmed.startsWith("### ")) {
          return (
            <h5
              key={i}
              className="mt-2 mb-0.5 font-medium text-foreground text-xs"
            >
              {trimmed.slice(4)}
            </h5>
          );
        }
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div
              key={i}
              className="pl-3 before:mr-1.5 before:text-muted-foreground/50 before:content-['·']"
            >
              {trimmed.slice(2)}
            </div>
          );
        }
        if (trimmed.startsWith("```")) {
          return (
            <div
              key={i}
              className="font-mono text-[10px] text-muted-foreground/70"
            >
              {trimmed}
            </div>
          );
        }
        if (trimmed === "") {
          return <div key={i} className="h-1.5" />;
        }
        return <div key={i}>{trimmed}</div>;
      })}
    </div>
  );
}

export const SlashCommandPicker: FC<SlashCommandPickerProps> = ({
  projectPath,
  query,
  anchorRef,
  onSelect,
  onClose,
}) => {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("skills");
  const [showPreview, setShowPreview] = useState(false);
  const [catalog, setCatalog] = useState<CatalogSkillCategory[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const { t } = useI18n();
  const slashListEpoch = useRef(0);
  const userCategories = useSkillCategoryStore((state) => state.categories);
  const categoryAssignments = useSkillCategoryStore(
    (state) => state.assignments,
  );
  const categorySnapshot = useMemo(
    () => ({ categories: userCategories, assignments: categoryAssignments }),
    [userCategories, categoryAssignments],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    right: number;
    bottom: number;
  }>({ left: 0, right: 0, bottom: 0 });

  const isSearching = query.length > 0;

  // Compute fixed position from anchor element
  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      left: rect.left,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [anchorRef]);

  // Load commands on mount and again after a skill install.
  // A slower in-flight list must not overwrite a newer SKILLS_LIST_UPDATED result.
  useEffect(() => {
    let cancelled = false;
    const load = (showLoading: boolean) => {
      const epoch = ++slashListEpoch.current;
      if (showLoading) setIsLoading(true);
      void Promise.resolve(
        invoke<SlashCommand[]>("slash_commands_list", {
          projectPath: projectPath ?? undefined,
        }),
      )
        .then((cmds) => {
          if (cancelled || epoch !== slashListEpoch.current) return;
          setCommands(Array.isArray(cmds) ? cmds : []);
          setIsLoading(false);
        })
        .catch(() => {
          if (cancelled || epoch !== slashListEpoch.current) return;
          setCommands([]);
          setIsLoading(false);
        });
    };
    load(true);
    const onSkillsUpdated = () => load(false);
    window.addEventListener(SKILLS_LIST_UPDATED_EVENT, onSkillsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(SKILLS_LIST_UPDATED_EVENT, onSkillsUpdated);
    };
  }, [projectPath]);

  useEffect(() => {
    invoke<CatalogSkillCategory[]>("get_skill_categories")
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  // Counts per tab (for badges)
  const tabCounts = useMemo(() => {
    const counts: Record<Tab, number> = { skills: 0, default: 0, custom: 0 };
    for (const cmd of commands) {
      counts[scopeToTab(cmd.scope)]++;
    }
    return counts;
  }, [commands]);

  // Filtered results: unified search or tab-scoped
  const filtered = useMemo(() => {
    const q = query.toLowerCase();

    if (isSearching) {
      return filterAndSort(commands, q);
    }

    const byTab = commands.filter((cmd) => scopeToTab(cmd.scope) === activeTab);
    return byTab;
  }, [query, commands, activeTab, isSearching]);

  const skillGroups = useMemo(() => {
    if (isSearching || activeTab !== "skills") return [];
    return groupItemsBySkillCategory(
      filtered,
      (cmd) => ({
        folder: skillFolderFromSlashCommand(cmd.full_command),
        name: cmd.name,
        category: cmd.category,
      }),
      categorySnapshot,
      catalog,
    );
  }, [activeTab, catalog, categorySnapshot, filtered, isSearching]);

  const isGroupExpanded = (groupId: string, defaultExpanded: boolean) =>
    expandedGroups[groupId] ?? defaultExpanded;

  const displayedCommands = useMemo(() => {
    if (isSearching || activeTab !== "skills") return filtered;
    return skillGroups.flatMap((group) =>
      isGroupExpanded(group.id, group.defaultExpanded) ? group.items : [],
    );
  }, [activeTab, expandedGroups, filtered, isSearching, skillGroups]);

  // The currently highlighted command
  const selectedCommand =
    displayedCommands.length > 0
      ? displayedCommands[Math.min(selectedIndex, displayedCommands.length - 1)]
      : null;
  const canPreview = Boolean(
    selectedCommand && commandHasPreview(selectedCommand),
  );
  const previewDescription = selectedCommand?.description?.trim() ?? "";
  const previewBody = selectedCommand?.content.trim() ?? "";
  const previewBodyDistinct =
    Boolean(previewBody) && previewBody !== previewDescription;

  // Group by scope for unified search display
  const searchGroups = useMemo(() => {
    if (!isSearching) return null;

    const groups: {
      label: string;
      items: { cmd: SlashCommand; globalIndex: number }[];
    }[] = [];
    const order: Tab[] = ["skills", "default", "custom"];
    const labels: Record<Tab, string> = {
      skills: "Skills",
      default: "Default",
      custom: "Custom",
    };

    for (const tab of order) {
      const items: { cmd: SlashCommand; globalIndex: number }[] = [];
      filtered.forEach((cmd, i) => {
        if (scopeToTab(cmd.scope) === tab) {
          items.push({ cmd, globalIndex: i });
        }
      });
      if (items.length > 0) {
        groups.push({ label: labels[tab], items });
      }
    }

    return groups;
  }, [filtered, isSearching]);

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, activeTab]);

  useEffect(() => {
    setSelectedIndex((prev) => {
      if (displayedCommands.length === 0) return 0;
      return Math.min(prev, displayedCommands.length - 1);
    });
  }, [displayedCommands.length]);

  // Close preview when switching away from a skill
  useEffect(() => {
    if (!canPreview) setShowPreview(false);
  }, [canPreview]);

  // Keyboard navigation via window listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          if (showPreview) {
            setShowPreview(false);
          } else {
            onClose();
          }
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          if (
            displayedCommands.length > 0 &&
            selectedIndex < displayedCommands.length
          ) {
            onSelect(displayedCommands[selectedIndex]);
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            Math.min(displayedCommands.length - 1, prev + 1),
          );
          break;
        case "ArrowRight":
          if (canPreview) {
            e.preventDefault();
            setShowPreview(true);
          }
          break;
        case "ArrowLeft":
          if (showPreview) {
            e.preventDefault();
            setShowPreview(false);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    displayedCommands,
    selectedIndex,
    onSelect,
    onClose,
    showPreview,
    canPreview,
  ]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector(
        `[data-index="${selectedIndex}"]`,
      );
      selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex]);

  const renderItem = (cmd: SlashCommand, index: number) => {
    const isSelected = index === selectedIndex;
    const previewable = commandHasPreview(cmd);
    return (
      <button
        key={cmd.id}
        type="button"
        data-index={index}
        data-testid={`slash-command-item-${cmd.id}`}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        )}
        onMouseDown={(e) => {
          e.preventDefault();
          const alreadyOpen =
            previewable && showPreview && index === selectedIndex;
          setSelectedIndex(index);
          if (alreadyOpen) {
            onSelect(cmd);
            return;
          }
          if (previewable) {
            setShowPreview(true);
          }
        }}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        {getCommandIcon(cmd)}
        <span className="truncate font-mono text-sm">{cmd.full_command}</span>
        {cmd.description && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {cmd.description}
          </span>
        )}
        {isSearching && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {SCOPE_LABEL[cmd.scope] ?? cmd.scope}
          </span>
        )}
        {previewable && isSelected && (
          <ChevronRightIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowPreview((v) => !v);
            }}
          />
        )}
      </button>
    );
  };

  const renderEmptyState = () => {
    if (isSearching) {
      return (
        <div className="flex flex-col items-center justify-center py-8">
          <SearchIcon className="mb-2 size-6 text-muted-foreground" />
          <span className="text-muted-foreground text-sm">
            No results for "{query}"
          </span>
        </div>
      );
    }

    const hints: Record<Tab, React.ReactNode> = {
      skills: (
        <p className="mt-1 px-4 text-center text-muted-foreground text-xs">
          Import skills into a category from Skills, or search to find a
          scientific skill.
        </p>
      ),
      default: null,
      custom: (
        <p className="mt-1 px-4 text-center text-muted-foreground text-xs">
          Add commands in <code className="px-1">claude-home/slash</code> or the
          paper <code className="px-1">.localprism/slash</code>
        </p>
      ),
    };

    return (
      <div className="flex flex-col items-center justify-center py-8">
        <span className="text-muted-foreground text-sm">
          No commands available
        </span>
        {hints[activeTab]}
      </div>
    );
  };

  const renderList = () => (
    <div className="flex-1 overflow-y-auto" ref={listRef}>
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <span className="text-muted-foreground text-sm">Loading...</span>
        </div>
      )}

      {!isLoading && filtered.length === 0 && renderEmptyState()}

      {!isLoading && filtered.length > 0 && (
        <div className="p-1.5">
          {isSearching && searchGroups ? (
            <div className="space-y-2">
              {searchGroups.map((group) => (
                <div key={group.label}>
                  <h3 className="px-3 py-1 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
                    {group.label}
                  </h3>
                  <div className="space-y-0.5">
                    {group.items.map(({ cmd, globalIndex }) =>
                      renderItem(cmd, globalIndex),
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : activeTab === "skills" && skillGroups.length > 0 ? (
            <div className="space-y-1">
              {skillGroups.map((group) => {
                const expanded = isGroupExpanded(
                  group.id,
                  group.defaultExpanded,
                );
                let runningIndex = 0;
                for (const earlier of skillGroups) {
                  if (earlier.id === group.id) break;
                  if (isGroupExpanded(earlier.id, earlier.defaultExpanded)) {
                    runningIndex += earlier.items.length;
                  }
                }
                return (
                  <div key={group.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-left font-semibold text-[10px] text-muted-foreground uppercase tracking-wider hover:bg-muted/60"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        setExpandedGroups((current) => ({
                          ...current,
                          [group.id]: !expanded,
                        }));
                      }}
                    >
                      {expanded ? (
                        <ChevronDownIcon className="size-3" />
                      ) : (
                        <ChevronRightIcon className="size-3" />
                      )}
                      <span className="truncate">
                        {group.id === "imported"
                          ? t("skills.uncategorized")
                          : group.name}
                      </span>
                      <span className="ml-auto tabular-nums">
                        {group.items.length}
                      </span>
                    </button>
                    {expanded && (
                      <div className="space-y-0.5">
                        {group.items.map((cmd, offset) =>
                          renderItem(cmd, runningIndex + offset),
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-0.5">
              {displayedCommands.map((cmd, i) => renderItem(cmd, i))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return createPortal(
    <div
      className="fixed flex overflow-hidden rounded-lg border border-border bg-background shadow-lg"
      style={{
        left: pos.left,
        right: pos.right,
        bottom: pos.bottom,
        maxHeight: "400px",
        zIndex: 9999,
      }}
    >
      {/* Left side: list */}
      <div
        className={cn(
          "flex flex-col overflow-hidden transition-all",
          showPreview ? "w-[45%] min-w-[200px]" : "w-full",
        )}
      >
        {/* Header */}
        <div className="shrink-0 border-border border-b px-3 pt-2.5 pb-2">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CommandIcon className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">
                {isSearching ? `Search: "${query}"` : "Commands"}
              </span>
            </div>
            <button
              aria-label="Close command picker"
              onMouseDown={(e) => {
                e.preventDefault();
                onClose();
              }}
              className="rounded-md p-1 transition-colors hover:bg-muted"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>

          {!isSearching && (
            <div className="flex gap-1">
              {(["skills", "default", "custom"] as const).map((tab) => (
                <button
                  key={tab}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                    activeTab === tab
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setActiveTab(tab);
                  }}
                >
                  {tab === "skills"
                    ? "Skills"
                    : tab === "default"
                      ? "Default"
                      : "Custom"}
                  {tabCounts[tab] > 0 && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-[10px] tabular-nums leading-4",
                        activeTab === tab
                          ? "bg-primary-foreground/20 text-primary-foreground"
                          : "bg-muted-foreground/15 text-muted-foreground",
                      )}
                    >
                      {tabCounts[tab]}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {renderList()}

        {/* Footer */}
        <div className="shrink-0 border-border border-t px-3 py-1">
          <span className="text-[10px] text-muted-foreground">
            ↑↓ Navigate · Enter Select
            {canPreview ? " · Click or → Preview" : ""} · Esc Close
          </span>
        </div>
      </div>

      {/* Right side: preview panel */}
      {showPreview && selectedCommand && commandHasPreview(selectedCommand) && (
        <div
          className="flex w-[55%] flex-col border-border border-l"
          data-testid="slash-command-preview"
        >
          <div className="flex shrink-0 items-center gap-2 border-border border-b px-3 py-2">
            <button
              aria-label="Close preview"
              onMouseDown={(e) => {
                e.preventDefault();
                setShowPreview(false);
              }}
              className="rounded-md p-0.5 transition-colors hover:bg-muted"
            >
              <ChevronLeftIcon className="size-3.5 text-muted-foreground" />
            </button>
            {getCommandIcon(selectedCommand)}
            <span className="truncate font-medium font-mono text-sm">
              {selectedCommand.full_command}
            </span>
            {SCOPE_LABEL[selectedCommand.scope] && (
              <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {SCOPE_LABEL[selectedCommand.scope]}
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2">
            {previewDescription ? (
              <p className="mb-2 text-foreground text-xs leading-relaxed">
                {previewDescription}
              </p>
            ) : null}
            {previewBodyDistinct ? (
              <CommandPreview content={previewBody} />
            ) : null}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};
