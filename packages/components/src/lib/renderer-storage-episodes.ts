import { rendererStorageFullAtom } from '@/atoms/local-storage-health';
import { onIpcEvent, sendIpc } from '@/lib/electron-ipc-client';
import { jotaiStore } from '@/lib/utils';

/**
 * Every repo in this window whose storage refused a write for lack of space,
 * including repos of workspaces the user already left: a runtime that is
 * disposed with unsaved changes keeps its repo open (`RepoStorageGuard`), and
 * stays here until recovery saved it. Spec: `specs/local-storage-health.md`.
 *
 * The earliest `since` drives the banner and is reported to Electron's main
 * process, whose quit barrier asks this window to flush before quitting.
 */
type Episode = { since: number | null; flushNow: () => Promise<number | null> };

export type RendererStorageEpisodeHandle = {
  report: (since: number | null) => void;
  /** A write was refused again, possibly inside an episode whose `since` is unchanged. */
  refused: () => void;
  release: () => void;
};

/** Main learns about writes refused after an approval at most this often. */
const REFUSAL_PUBLISH_INTERVAL_MS = 500;

export type RendererStorageEpisodesOptions = {
  setTimer?: (callback: () => void, delayMs: number) => unknown;
};

export class RendererStorageEpisodes {
  private readonly episodes = new Map<symbol, Episode>();
  private published: number | null = null;
  /**
   * Counts refused writes. Main voids an unload approval when it sees a newer
   * report, so data that became unsaved after the approval is asked about again.
   */
  private revision = 0;
  private publishedRevision = 0;
  private refusalTimer: unknown = null;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;

  constructor(
    private readonly publish: (since: number | null, revision: number) => void,
    options: RendererStorageEpisodesOptions = {}
  ) {
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  register(flushNow: () => Promise<number | null>): RendererStorageEpisodeHandle {
    const key = Symbol('renderer-storage-episode');
    this.episodes.set(key, { since: null, flushNow });
    return {
      report: (since) => {
        const episode = this.episodes.get(key);
        if (!episode) return;
        episode.since = since;
        this.update();
      },
      refused: () => {
        if (!this.episodes.has(key)) return;
        this.revision += 1;
        // Coalesced: a burst of refused saves (typing on a full disk) is one report.
        if (this.refusalTimer !== null) return;
        this.refusalTimer = this.setTimer(() => {
          this.refusalTimer = null;
          this.update();
        }, REFUSAL_PUBLISH_INTERVAL_MS);
      },
      release: () => {
        this.episodes.delete(key);
        this.update();
      },
    };
  }

  get earliestUnsaved(): number | null {
    let earliest: number | null = null;
    for (const { since } of this.episodes.values()) {
      if (since !== null && (earliest === null || since < earliest)) earliest = since;
    }
    return earliest;
  }

  /**
   * `beforeunload` guard: closing, reloading or navigating this window would drop
   * repos that still hold unsaved changes, so the unload is cancelled. Electron's
   * main process then gets `will-prevent-unload`, asks this window to flush
   * (`storage.quitCheck`), and repeats the action once it saved, or once the
   * user chose to discard. A browser shows its own "leave site?" prompt.
   */
  handleBeforeUnload(event: Pick<BeforeUnloadEvent, 'preventDefault' | 'returnValue'>): void {
    if (this.earliestUnsaved === null) return;
    event.preventDefault();
    // Legacy engines only honour a non-empty returnValue.
    event.returnValue = 'unsaved';
  }

  /** The quit-time answer: flush every repo holding unsaved changes, then report what is left. */
  async flushForQuit(): Promise<number | null> {
    const pending = [...this.episodes.values()].filter((episode) => episode.since !== null);
    await Promise.allSettled(pending.map((episode) => episode.flushNow()));
    return this.earliestUnsaved;
  }

  private update(): void {
    const earliest = this.earliestUnsaved;
    const newlyRefused = earliest !== null && this.revision !== this.publishedRevision;
    if (earliest === this.published && !newlyRefused) return;
    this.published = earliest;
    this.publishedRevision = this.revision;
    this.publish(earliest, this.revision);
  }
}

export const rendererStorageEpisodes = new RendererStorageEpisodes((since, revision) => {
  jotaiStore.set(rendererStorageFullAtom, since === null ? null : { since });
  sendIpc('storage.rendererUnsaved', { since, revision });
});

let quitCheckInstalled = false;

/**
 * Answers Electron's quit and window barriers, and guards this window's unload;
 * idempotent.
 */
export const installRendererStorageQuitCheck = (): void => {
  if (quitCheckInstalled) return;
  quitCheckInstalled = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (event) =>
      rendererStorageEpisodes.handleBeforeUnload(event)
    );
  }
  onIpcEvent('storage.quitCheck', ({ requestId }) => {
    void rendererStorageEpisodes.flushForQuit().then((since) => {
      sendIpc('storage.quitCheckResult', { requestId, since });
    });
  });
};
