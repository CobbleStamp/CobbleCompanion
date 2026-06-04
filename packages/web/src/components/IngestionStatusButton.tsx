/**
 * Header indicator that appears only while the companion is still reading
 * something. Shows how many sources are in flight and opens the status panel.
 * Hidden (renders null) when nothing is pending, like the usage badge.
 */

interface IngestionStatusButtonProps {
  readonly activeCount: number;
  readonly onClick: () => void;
}

export function IngestionStatusButton({
  activeCount,
  onClick,
}: IngestionStatusButtonProps): JSX.Element | null {
  if (activeCount === 0) return null;

  return (
    <button
      type="button"
      className="ingestion-badge"
      aria-label="View ingestion status"
      onClick={onClick}
    >
      Reading… {activeCount}
    </button>
  );
}
