import type { CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';

/** A modern iPhone in portrait, for a device that reported no screen size. */
const FALLBACK_ASPECT_RATIO = 9 / 19.5;

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
  title: string;
  screen?: { width: number; height: number };
};

export function getIosSimulatorAspectRatio(screen?: { width: number; height: number }): number {
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) return FALLBACK_ASPECT_RATIO;
  return screen.width / screen.height;
}

/**
 * The simulator's screen, fitted whole inside the panel at the device's own
 * aspect ratio. The page inside is the machine's dedicated viewer; this frame
 * only sizes it. It is mounted only while the panel is on screen, so a hidden
 * panel holds no stream open.
 */
export function IosSimulatorViewer({ viewerUrl, title, screen }: IosSimulatorViewerProps) {
  const aspect = { '--ios-simulator-aspect': String(getIosSimulatorAspectRatio(screen)) };
  return (
    <div {...stylex.props(styles.stage)} data-testid="ios-simulator-viewer">
      <iframe
        {...stylex.props(styles.frame)}
        style={aspect as CSSProperties}
        src={viewerUrl}
        title={title}
        referrerPolicy="no-referrer"
        // An opaque origin: the viewer authenticates by its URL capability and
        // needs no cookies or storage of its own.
        sandbox="allow-scripts"
      />
    </div>
  );
}
