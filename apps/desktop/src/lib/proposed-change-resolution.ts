interface CompleteProposedChangeActionOptions {
  action: () => Promise<boolean>;
  isCurrent: () => boolean;
  onResolved: () => void;
  onRejected: (error: unknown) => void;
}

/** Resolves UI merge state only after its filesystem action really succeeds. */
export async function completeProposedChangeAction({
  action,
  isCurrent,
  onResolved,
  onRejected,
}: CompleteProposedChangeActionOptions): Promise<boolean> {
  try {
    const resolved = await action();
    if (!resolved || !isCurrent()) return false;
    onResolved();
    return true;
  } catch (error) {
    onRejected(error);
    return false;
  }
}
