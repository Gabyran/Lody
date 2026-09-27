import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import {
  IOS_SIMULATOR_VIEWER_INIT,
  IOS_SIMULATOR_VIEWER_VISIBILITY,
  getIosSimulatorAspectRatio,
  parseIosSimulatorViewerState,
} from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDeviceFamily,
  IosSimulatorViewerState,
} from '@/lib/ios-simulator/ios-simulator-types';

const styles = stylex.create({
  /** A size container, so the frame can fit by whichever axis runs out first. */
  stage: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    padding: space[4],
    containerType: 'size',
  },
  frame: {
    display: 'block',
    boxSizing: 'border-box',
    width: 'min(100cqw, calc(100cqh * var(--ios-simulator-aspect)))',
    aspectRatio: 'var(--ios-simulator-aspect)',
    borderWidth: 0,
    borderRadius: radius.large,
    backgroundColor: colors.background,
    boxShadow: shadow.card,
  },
});

export type IosSimulatorViewerProps = {
  viewerUrl: string;
  /** Exact origin of `viewerUrl`, already checked not to be the app's own. */
  viewerOrigin: string;
  operationId: string;
  title: string;
  family?: IosSimulatorDeviceFamily;
  /** The panel is on screen. Combined with the document's own visibility. */
  visible: boolean;
  onStateChange: (state: IosSimulatorViewerState) => void;
};

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/**
 * The simulator's screen, fitted whole inside the panel. The page inside is
 * the machine's dedicated viewer, which draws frames and forwards input itself;
 * this frame sizes it and runs the handshake.
 *
 * After each load the panel sends `init` to the frame's exact origin, and from
 * then on accepts `state` only from that frame's window, that origin and that
 * operation. Hiding the panel does not unmount the frame — it tells the viewer
 * it is hidden, and the viewer pauses its stream.
 */
export function IosSimulatorViewer({
  viewerUrl,
  viewerOrigin,
  operationId,
  title,
  family,
  visible,
  onStateChange,
}: IosSimulatorViewerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [screenAspect, setScreenAspect] = useState<number | null>(null);
  const firstFrameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sentVisibleRef = useRef<boolean | null>(null);
  const documentVisible = useDocumentVisible();
  const effectiveVisible = visible && documentVisible;
  const visibleRef = useRef(effectiveVisible);
  visibleRef.current = effectiveVisible;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== viewerOrigin) return;
      const state = parseIosSimulatorViewerState(event.data, operationId);
      if (!state) return;
      if (state !== 'connecting') clearTimeout(firstFrameTimer.current);
      const { width, height } = event.data;
      if (
        state === 'ready' &&
        Number.isInteger(width) &&
        Number.isInteger(height) &&
        width > 0 &&
        height > 0 &&
        width <= 16384 &&
        height <= 16384
      ) {
        setScreenAspect(width / height);
      }
      onStateChangeRef.current(state);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [operationId, viewerOrigin]);

  // A failed iframe navigation may never send a state. Offer Restore instead of
  // leaving a blank screen indefinitely, including after returning to the panel.
  useEffect(() => {
    if (!effectiveVisible) return undefined;
    firstFrameTimer.current = setTimeout(() => onStateChangeRef.current('error'), 25_000);
    return () => clearTimeout(firstFrameTimer.current);
  }, [effectiveVisible, viewerUrl, operationId]);

  // A new address is a new document: it has to be greeted again.
  useEffect(() => {
    setLoaded(false);
    setScreenAspect(null);
  }, [viewerUrl]);

  useEffect(() => {
    if (!loaded || sentVisibleRef.current === effectiveVisible) return;
    sentVisibleRef.current = effectiveVisible;
    frameRef.current?.contentWindow?.postMessage(
      { type: IOS_SIMULATOR_VIEWER_VISIBILITY, operationId, visible: effectiveVisible },
      viewerOrigin
    );
  }, [effectiveVisible, loaded, operationId, viewerOrigin]);

  const handleLoad = () => {
    sentVisibleRef.current = visibleRef.current;
    frameRef.current?.contentWindow?.postMessage(
      { type: IOS_SIMULATOR_VIEWER_INIT, operationId, visible: visibleRef.current },
      viewerOrigin
    );
    setLoaded(true);
  };

  const aspect = {
    '--ios-simulator-aspect': String(screenAspect ?? getIosSimulatorAspectRatio(family)),
  };
  return (
    <div {...stylex.props(styles.stage)} data-testid="ios-simulator-viewer">
      <iframe
        ref={frameRef}
        {...stylex.props(styles.frame)}
        style={aspect as CSSProperties}
        src={viewerUrl}
        title={title}
        referrerPolicy="no-referrer"
        // The handshake names the viewer's exact origin, so the frame keeps it.
        // That is safe only because `getIosSimulatorViewerOrigin` rejects a
        // viewer on the app's own origin; everything else stays sandboxed.
        // oxlint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-scripts allow-same-origin"
        onLoad={handleLoad}
      />
    </div>
  );
}
