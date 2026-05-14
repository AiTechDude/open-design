// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@open-design/contracts';

import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    updateDesignSystemDraft: vi.fn(async () => null),
    deleteDesignSystemDraft: vi.fn(async () => true),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const systems: DesignSystemSummary[] = [
  {
    id: 'user:acme',
    title: 'Acme Design System',
    category: 'Custom',
    summary: 'Internal product system.',
    surface: 'web',
    source: 'user',
    status: 'draft',
    isEditable: true,
    updatedAt: '2026-05-13T03:19:00.000Z',
  },
  {
    id: 'linear',
    title: 'Linear',
    category: 'Productivity & SaaS',
    summary: 'Quiet issue-tracker system.',
    surface: 'web',
    source: 'bundled',
    status: 'published',
    isEditable: false,
  },
];

describe('DesignSystemsTab', () => {
  it('surfaces only user-created design systems in the Claude-style manager', () => {
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId="user:acme"
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
      />,
    );

    const section = screen.getByLabelText('Design Systems');
    expect(within(section).getByText('Create new design system')).toBeTruthy();
    expect(within(section).getByText('Acme Design System')).toBeTruthy();
    expect(within(section).getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.queryByText('Linear')).toBeNull();
  });

  it('routes create and open actions to the dedicated design-system flow', () => {
    const onCreate = vi.fn();
    const onOpenSystem = vi.fn();
    render(
      <DesignSystemsTab
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={onCreate}
        onOpenSystem={onOpenSystem}
      />,
    );

    fireEvent.click(screen.getByText('Create new design system'));
    expect(onCreate).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByLabelText('Open Acme Design System'));
    expect(onOpenSystem).toHaveBeenCalledWith('user:acme');
  });
});
