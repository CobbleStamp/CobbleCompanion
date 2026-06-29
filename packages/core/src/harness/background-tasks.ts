/**
 * A group of fire-and-forget background tasks the harness launches off the request
 * path (the post-turn affect read + user-fact capture). It exists so a graceful
 * shutdown — or a test asserting the read's effects — can await them settling without
 * the harness owning the bookkeeping itself. Each task is expected to be self-catching,
 * so {@link whenIdle} never rejects.
 */
export class BackgroundTaskGroup {
  private readonly tasks = new Set<Promise<void>>();

  /** Register a self-catching task so {@link whenIdle} can await it; auto-removed once settled. */
  track(task: Promise<void>): void {
    const tracked = task.finally(() => {
      this.tasks.delete(tracked);
    });
    this.tasks.add(tracked);
  }

  /**
   * Resolve once every tracked task has settled. Loops because a settling task may
   * (in principle) register another; never rejects, since each task self-catches.
   */
  async whenIdle(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.all([...this.tasks]);
    }
  }
}
