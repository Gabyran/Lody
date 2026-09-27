import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { LocalStorageBannerState } from '@/atoms/local-storage-health';
import { LocalStorageBanner, useLocalStorageBannerLabels } from '@/components/local-storage-banner';

const GIB = 1024 * 1024 * 1024;

function StateBanner({
  state,
  onDismiss,
}: {
  state: LocalStorageBannerState;
  onDismiss?: () => void;
}) {
  const labels = useLocalStorageBannerLabels(state);
  const warning = state.kind === 'low-space' && state.level === 'warning';
  return (
    <LocalStorageBanner
      tone={warning ? 'warning' : 'danger'}
      labels={labels}
      {...(warning && onDismiss ? { onDismiss } : {})}
    />
  );
}

const meta = {
  title: 'Components/LocalStorageBanner',
  component: StateBanner,
  args: { onDismiss: fn() },
} satisfies Meta<typeof StateBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunningLow: Story = {
  args: { state: { kind: 'low-space', level: 'warning', availableBytes: 3.2 * GIB } },
};

export const AlmostFull: Story = {
  args: { state: { kind: 'low-space', level: 'critical', availableBytes: 0.4 * GIB } },
};

export const WritesFailing: Story = {
  args: {
    state: { kind: 'write-failed', since: Date.UTC(2026, 8, 27, 11, 4), source: 'machine' },
  },
};

export const AppStorageFull: Story = {
  args: {
    state: { kind: 'write-failed', since: Date.UTC(2026, 8, 27, 11, 4), source: 'app' },
  },
};
