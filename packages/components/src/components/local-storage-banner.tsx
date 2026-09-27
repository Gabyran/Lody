import { useEffect } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { formatFileSize } from '@/lib/session-file-presentation';
import {
  localStorageBannerStateAtom,
  type LocalStorageBannerState,
} from '@/atoms/local-storage-health';

const styles = stylex.create({
  dock: {
    position: 'fixed',
    insetInline: 0,
    top: '12px',
    zIndex: 40,
    display: 'flex',
    justifyContent: 'center',
    paddingInline: '16px',
    pointerEvents: 'none',
  },
  card: { width: '100%', maxWidth: '480px', pointerEvents: 'auto' },
});

export type LocalStorageBannerLabels = {
  title: string;
  description: string;
  dismiss?: string;
};

/**
 * App-level notice for the disk holding Lody's data. Pinned to the top: unlike
 * a stuck connection, this one changes what the user can do next (new turns
 * are refused), so it belongs where they look before sending.
 */
export function LocalStorageBanner({
  tone,
  labels,
  onDismiss,
}: {
  tone: 'warning' | 'danger';
  labels: LocalStorageBannerLabels;
  onDismiss?: () => void;
}) {
  return (
    <div {...stylex.props(styles.dock)}>
      <div {...stylex.props(styles.card)}>
        <Alert.Root tone={tone}>
          <Alert.Title>{labels.title}</Alert.Title>
          <Alert.Description>{labels.description}</Alert.Description>
          {onDismiss && labels.dismiss ? (
            <Alert.Actions>
              <Button variant="secondary" size="small" onClick={onDismiss}>
                {labels.dismiss}
              </Button>
            </Alert.Actions>
          ) : null}
        </Alert.Root>
      </div>
    </div>
  );
}

/** Only the warning can be dismissed, and only until the level changes. */
const dismissedWarningAtom = atom(false);

const formatSince = (since: number, language: string | undefined): string =>
  new Intl.DateTimeFormat(language === 'zh_CN' ? 'zh-CN' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(since));

export function useLocalStorageBannerLabels(
  state: LocalStorageBannerState
): LocalStorageBannerLabels {
  const { t, i18n } = useTranslation();
  if (state.kind === 'write-failed') {
    const unsaved =
      state.since === null
        ? t('localStorage.banner.unsaved', 'Some changes are not saved yet.')
        : t('localStorage.banner.unsavedSince', {
            defaultValue: 'Unsaved changes since {{time}}.',
            time: formatSince(state.since, i18n.language),
          });
    const kept =
      state.source === 'app'
        ? t(
            'localStorage.banner.appFullDescription',
            "This app's local storage is full. Changes are kept in memory and saved automatically once space is freed."
          )
        : t(
            'localStorage.banner.fullDescription',
            'Changes are kept in memory and saved automatically once space is freed. New sessions, turns and attachments are paused.'
          );
    return {
      title: t('localStorage.banner.fullTitle', 'Disk is full'),
      // The join is localized: Chinese puts no space between sentences.
      description: t('localStorage.banner.fullWithUnsaved', {
        defaultValue: '{{kept}} {{unsaved}}',
        kept,
        unsaved,
      }),
    };
  }
  const free =
    state.availableBytes === null
      ? t('localStorage.banner.freeUnknown', 'Little space')
      : formatFileSize(state.availableBytes);
  if (state.level === 'critical') {
    return {
      title: t('localStorage.banner.criticalTitle', 'Disk almost full'),
      description: t('localStorage.banner.criticalDescription', {
        defaultValue:
          '{{free}} left. New sessions, turns and attachments are paused until space is freed.',
        free,
      }),
    };
  }
  return {
    title: t('localStorage.banner.warningTitle', 'Disk space is running low'),
    description: t('localStorage.banner.warningDescription', {
      defaultValue: "{{free}} left on the disk holding Lody's data.",
      free,
    }),
    dismiss: t('localStorage.banner.dismiss', 'Dismiss'),
  };
}

function LocalStorageBannerForState({
  state,
  onDismiss,
}: {
  state: LocalStorageBannerState;
  onDismiss?: () => void;
}) {
  const labels = useLocalStorageBannerLabels(state);
  return (
    <LocalStorageBanner
      tone={onDismiss ? 'warning' : 'danger'}
      labels={labels}
      {...(onDismiss ? { onDismiss } : {})}
    />
  );
}

/** Mounted once in `MainLayout`; renders nothing while storage is healthy. */
export function LocalStorageBannerContainer() {
  const state = useAtomValue(localStorageBannerStateAtom);
  const [dismissed, setDismissed] = useAtom(dismissedWarningAtom);
  const isWarning = state?.kind === 'low-space' && state.level === 'warning';
  // A dismissed warning comes back once storage got better or worse in between.
  useEffect(() => {
    if (!isWarning) setDismissed(false);
  }, [isWarning, setDismissed]);
  if (!state || (isWarning && dismissed)) return null;
  return (
    <LocalStorageBannerForState
      state={state}
      {...(isWarning ? { onDismiss: () => setDismissed(true) } : {})}
    />
  );
}
