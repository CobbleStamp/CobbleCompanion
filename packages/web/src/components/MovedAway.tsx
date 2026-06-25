/**
 * The full-screen "moved to another device" state (deliver-scalability.md §5.2,
 * "newer wins"). One companion lives in one room at a time, so when another tab or
 * device claims it, the server supersedes this connection. Rather than fight over the
 * room (two ends would auto-reconnect forever), this window goes quiet and shows this
 * screen. "Move {name} here" force-claims the room back — the transport reconnects
 * with a strictly-greater owner token, which wins.
 */
interface MovedAwayProps {
  readonly companionName: string;
  /** Reclaim the room on this window: reconnect, force-claim, and resume the chat. */
  readonly onMoveHere: () => void;
}

export function MovedAway({ companionName, onMoveHere }: MovedAwayProps): JSX.Element {
  return (
    <main className="card moved-screen" role="alert">
      <p className="moved-icon" aria-hidden="true">
        🐾
      </p>
      <h1>{companionName} is on another device</h1>
      <p>
        {companionName} can only be awake in one place at a time, and it just moved to another
        window or device. This window has gone quiet so the two don’t talk over each other.
      </p>
      <button type="button" onClick={onMoveHere}>
        Move {companionName} here
      </button>
    </main>
  );
}
