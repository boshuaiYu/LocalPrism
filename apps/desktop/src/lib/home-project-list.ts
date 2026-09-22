export type HomeProjectListState = "empty" | "no-results" | "list";

export const OPEN_FOLDER_HINT = "Open Folder uses your system folder picker.";

export function homeProjectListState(input: {
  recentCount: number;
  query: string;
  matchCount: number;
}): HomeProjectListState {
  if (input.query.trim() && input.matchCount === 0) return "no-results";
  if (input.recentCount === 0) return "empty";
  return "list";
}
