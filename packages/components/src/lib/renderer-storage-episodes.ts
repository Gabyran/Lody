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
  release: () => void;
};

export class RendererStorageEpisodes {
  private readonly episodes = new Map<symbol, Episode>();
  private published: number | null = null;

  constructor(private readonly publish: (since: number | null) => void) {}

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

  /** The quit-time answer: flush every repo holding unsaved changes, then report what is left. */
  async flushForQuit(): Promise<number | null> {
    const pending = [...this.episodes.values()].filter((episode) => episode.since !== null);
    await Promise.allSettled(pending.map((episode) => episode.flushNow()));
    return this.earliestUnsaved;
  }

  private update(): void {
    const earliest = this.earliestUnsaved;
    if (earliest === this.published) return;
    this.published = earliest;
    this.publish(earliest);
  }
}

export const rendererStorageEpisodes = new RendererStorageEpisodes((since) => {
  jotaiStore.set(rendererStorageFullAtom, since === null ? null : { since });
  sendIpc('storage.rendererUnsaved', { since });
});

let quitCheckInstalled = false;

/** Answers Electron's quit barrier; idempotent, a no-op outside Electron. */
export const installRendererStorageQuitCheck = (): void => {
  if (quitCheckInstalled) return;
  quitCheckInstalled = true;
  onIpcEvent('storage.quitCheck', ({ requestId }) => {
    void rendererStorageEpisodes.flushForQuit().then((since) => {
      sendIpc('storage.quitCheckResult', { requestId, since });
    });
  });
};
