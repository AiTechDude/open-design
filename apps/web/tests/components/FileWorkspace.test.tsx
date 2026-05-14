// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileWorkspace, scrollWorkspaceTabsWithWheel } from '../../src/components/FileWorkspace';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import { projectSplitClassName } from '../../src/components/ProjectView';
import type { AgentEvent, DesignSystemSummary, ProjectFile } from '../../src/types';

const registryMocks = vi.hoisted(() => ({
  updateDesignSystemDraft: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    updateDesignSystemDraft: registryMocks.updateDesignSystemDraft,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  registryMocks.updateDesignSystemDraft.mockReset();
  vi.unstubAllGlobals();
});

function workspaceFile(name: string): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 100,
    mtime: 1700000000,
    kind: name.endsWith('.html') ? 'html' : 'text',
    mime: name.endsWith('.html') ? 'text/html' : 'text/plain',
  };
}

type ToolUseEvent = Extract<AgentEvent, { kind: 'tool_use' }>;
type ToolResultEvent = Extract<AgentEvent, { kind: 'tool_result' }>;

function toolUse(name: string, input: unknown, id: string): ToolUseEvent {
  return { kind: 'tool_use', id, name, input };
}

function toolOk(id: string): ToolResultEvent {
  return { kind: 'tool_result', toolUseId: id, content: '', isError: false };
}

function todoWrite(
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }>,
): ToolUseEvent {
  return toolUse('TodoWrite', { todos }, 'todo-write');
}

function renderWorkspace(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(element);
  });
  return host;
}

function getTabByName(container: HTMLElement, name: RegExp): HTMLElement {
  const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
  const tab = tabs.find((node) => name.test(node.textContent ?? ''));
  if (!tab) throw new Error(`Could not find tab matching ${name}`);
  return tab;
}

function createDragDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'move',
    dropEffect: 'move',
    getData: vi.fn((type: string) => store.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
  };
}

function dispatchDragEvent(
  target: HTMLElement,
  type: string,
  dataTransfer = createDragDataTransfer(),
  clientX = 0,
  relatedTarget: EventTarget | null = null,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    dataTransfer: { value: dataTransfer },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return dataTransfer;
}

function stubTabRect(tab: HTMLElement, left = 0, width = 100) {
  tab.getBoundingClientRect = vi.fn(() => ({
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: 20,
    width,
    height: 20,
    toJSON: () => ({}),
  }));
}

describe('FileWorkspace upload input', () => {
  it('keeps the Design Files picker aligned with drag-and-drop file support', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        files={[]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="design-files-upload-input"');
    expect(markup).not.toContain('accept=');
  });

  it('keeps focus mode controls in the workspace tab bar', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        files={[]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode={false}
        onFocusModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="workspace-focus-toggle"');
    expect(markup).toContain('Focus workspace');
  });

  it('keeps the focus mode action outside the horizontally scrollable tablist', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        files={[]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode={false}
        onFocusModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('class="ws-tabs-shell"');
    expect(markup).toContain('class="ws-tabs-actions"');
    expect(markup).toMatch(
      /<div class="ws-tabs-bar" role="tablist"[^>]*>[\s\S]*?<\/div><div class="ws-tabs-actions">/,
    );
  });

  it('labels the same workspace control as chat restore while focused', () => {
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="project-1"
        files={[]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        focusMode
        onFocusModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain('Show chat');
  });

  it('adds a Design System tab for project-backed design systems', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[
          workspaceFile('DESIGN.md'),
          workspaceFile('colors_and_type.css'),
          workspaceFile('preview/typography-scale.html'),
          workspaceFile('preview/colors-node-types.html'),
          workspaceFile('preview/spacing-system.html'),
          workspaceFile('ui_kits/generated_interface/index.html'),
          workspaceFile('preview/logo-variants.html'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );

    expect(markup).toContain('data-testid="design-system-project-tab"');
    expect(markup).toContain('Review draft design system');
    expect(markup).toContain('Your design system is ready, but your feedback will improve it.');
    expect(markup).toContain('Published');
    expect(markup).toContain('Missing brand fonts');
    expect(markup).toContain('Upload fonts');
    expect(markup).toContain('Needs review');
    expect(markup).toContain('Type');
    expect(markup).toContain('Colors');
    expect(markup).toContain('Spacing');
    expect(markup).toContain('Components');
    expect(markup).toContain('Brand');
    expect(markup).toContain('typography-scale');
    expect(markup).toContain('colors-node-types');
    expect(markup).toContain('spacing-system');
    expect(markup).toContain('generated-interface');
    expect(markup).toContain('logo-variants');
    expect(markup).toContain('Looks good');
    expect(markup).toContain('Needs work...');
    expect(markup).toContain('data-testid="design-files-tab"');
  });

  it('keeps the review surface in the creation state while the initial draft is still source-only', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        streaming
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );

    expect(markup).toContain('Creating your design system...');
    expect(markup).not.toContain('Design system generation steps');
    expect(markup).not.toContain('Review draft design system');
    expect(markup).not.toContain('Review status');
  });

  it('reveals generated design-system sections while the run continues', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[
          workspaceFile('DESIGN.md'),
          workspaceFile('colors_and_type.css'),
          workspaceFile('preview/colors.html'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        streaming
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );

    expect(markup).toContain('Review draft design system');
    expect(markup).toContain('Needs review');
    expect(markup).toContain('colors');
    expect(markup).toContain('Colors');
    expect(markup).not.toContain('Context source');
  });

  it('shows a Claude-style creating state before the design-system draft has files to review', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
      provenance: {
        companyBlurb: 'Acme: analytics workspace for operations teams',
      },
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('context/source-context.md')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        streaming
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemActivityEvents={[
          todoWrite([
            { content: 'Create README.md with high-level company/product understanding', status: 'in_progress' },
            { content: 'Create colors_and_type.css with CSS variables', status: 'pending' },
          ]),
        ]}
      />,
    );

    expect(markup).toContain('Creating your design system...');
    expect(markup).toContain('Keep this tab open. You can come back in a few minutes.');
    expect(markup).toContain('role="progressbar"');
    expect(markup).not.toContain('Explore provided resources');
    expect(markup).not.toContain('Create DESIGN.md');
    expect(markup).not.toContain('Review draft design system');
  });

  it('marks a design-system section as updating from active agent file operations', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[
          workspaceFile('DESIGN.md'),
          workspaceFile('colors_and_type.css'),
          workspaceFile('preview/colors.html'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemActivityEvents={[
          toolUse('Write', { file_path: '/project/colors_and_type.css' }, 'write-tokens'),
        ]}
      />,
    );

    expect(markup).toContain('Writing tokens');
    expect(markup).toContain('Writing tokens now.');
  });

  it('shows queued design-system sections from the agent todo list', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemActivityEvents={[
          todoWrite([
            { content: 'Create color palette preview card for Design System tab', status: 'pending' },
          ]),
        ]}
      />,
    );

    expect(markup).toContain('Review draft design system');
    expect(markup).toContain('colors');
    expect(markup).toContain('Needs review');
  });

  it('maps in-progress design-system todos to the right review section', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemActivityEvents={[
          todoWrite([
            { content: 'Create colors_and_type.css with CSS variables', status: 'in_progress' },
          ]),
        ]}
      />,
    );

    expect(markup).toContain('Writing tokens');
    expect(markup).toContain('Writing tokens now.');
  });

  it('shows a reading phase when the agent is inspecting design-system source files', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/typography-scale.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemActivityEvents={[
          toolUse('Read', { file_path: '/project/preview/typography-scale.html' }, 'read-type'),
        ]}
      />,
    );

    expect(markup).toContain('Open Design is reading typography-scale context for this section.');
  });

  it('marks a design-system section for review after the latest agent run edits it', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemActivityEvents={[
          toolUse('Write', { file_path: '/project/preview/colors.html' }, 'write-preview'),
          toolOk('write-preview'),
        ]}
      />,
    );

    expect(markup).toContain('Review updated files');
    expect(markup).toContain('This section changed during the latest run. Review it before publishing.');
  });

  it('routes Design System Needs work feedback back into the project chat', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const onNeedsWork = vi.fn();
    const onReviewDecision = vi.fn();
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        onDesignSystemNeedsWork={onNeedsWork}
        onDesignSystemReviewDecision={onReviewDecision}
      />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-system-review-work-colors"]',
    );
    expect(button).toBeTruthy();
    act(() => {
      button?.click();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('#ds-feedback-colors');
    expect(textarea).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'Make the usage guidance more specific.');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((node) => node.textContent?.includes('Send feedback'));
    expect(send).toBeTruthy();
    act(() => {
      send?.click();
    });

    expect(onNeedsWork).toHaveBeenCalledWith(
      'colors',
      'Make the usage guidance more specific.',
      ['preview/colors.html'],
    );
    expect(onReviewDecision).toHaveBeenLastCalledWith('colors', 'needs-work', {
      feedback: 'Make the usage guidance more specific.',
      files: ['preview/colors.html'],
    });
  });

  it('persists the agent task created from Needs work feedback', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const agentTask = {
      status: 'queued' as const,
      prompt: 'Needs work on the design system section "colors".',
      queuedAt: '2026-05-14T00:00:04.000Z',
    };
    const onNeedsWork = vi.fn(() => agentTask);
    const onReviewDecision = vi.fn();
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        onDesignSystemNeedsWork={onNeedsWork}
        onDesignSystemReviewDecision={onReviewDecision}
      />,
    );

    act(() => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="design-system-review-work-colors"]',
      )?.click();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('#ds-feedback-colors');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'Regenerate the dark palette with stronger contrast.');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((node) => node.textContent?.includes('Send feedback'));
    act(() => {
      send?.click();
    });

    expect(onReviewDecision).toHaveBeenLastCalledWith('colors', 'needs-work', {
      feedback: 'Regenerate the dark palette with stronger contrast.',
      files: ['preview/colors.html'],
      agentTask,
    });
  });

  it('restores persisted design-system review decisions from project metadata', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemReview={{
          colors: {
            decision: 'looks-good',
            updatedAt: '2026-05-14T00:00:00.000Z',
          },
        }}
      />,
    );

    expect(container.querySelector('.ds-project-section-dot.is-approved')?.textContent).toContain(
      'Looks good',
    );
  });

  it('shows saved Needs work feedback in the review overview until files change', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const colorsPreview = workspaceFile('preview/colors.html');
    colorsPreview.mtime = Date.parse('2026-05-14T00:00:00.000Z');
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), colorsPreview]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemReview={{
          colors: {
            decision: 'needs-work',
            updatedAt: '2026-05-14T00:00:03.000Z',
            feedback: 'Make the usage guidance more specific.',
            files: ['preview/colors.html'],
            agentTask: {
              status: 'queued',
              prompt: 'Needs work on the design system section "colors".',
              queuedAt: '2026-05-14T00:00:04.000Z',
            },
          },
        }}
      />,
    );

    expect(container.textContent).toContain('Last feedback');
    expect(container.textContent).toContain('Make the usage guidance more specific.');
    expect(container.textContent).toContain('The agent will pick it up when the current run finishes.');
    expect(container.textContent).not.toContain('Review updated files');
  });

  it('shows inline generated previews inside the design-system review overview', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );

    expect(markup).toContain('<iframe');
    expect(markup).toContain('title="preview/colors.html"');
  });

  it('keeps source context out of the Claude-style Design System review tab', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
      provenance: {
        companyBlurb: 'Acme: analytics workspace for operations teams',
        githubUrls: ['https://github.com/acme/product'],
        localCodeFiles: ['/Users/acme/product-ui'],
        figFiles: ['brand.fig'],
        assetFiles: ['logo.svg'],
        notes: 'Use compact operational UI patterns.',
        sourceNotes: 'GitHub metadata: React UI library with token CSS.',
      },
    };
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );

    expect(markup).toContain('Review draft design system');
    expect(markup).toContain('Preview cards will appear here as the agent creates them.');
    expect(markup).not.toContain('Source context');
    expect(markup).not.toContain('https://github.com/acme/product');
    expect(markup).not.toContain('GitHub metadata: React UI library with token CSS.');
  });

  it('separates source evidence files from uploaded brand assets in design-system review', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const logo = workspaceFile('assets/logo.svg');
    logo.kind = 'image';
    logo.mime = 'image/svg+xml';
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[
          workspaceFile('DESIGN.md'),
          workspaceFile('context/source-context.md'),
          workspaceFile('context/github/acme-product.md'),
          workspaceFile('context/github/acme-product/files/src/components/Button.tsx'),
          logo,
          workspaceFile('preview/logo-variants.html'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );

    expect(container.textContent).toContain('Brand');
    expect(container.textContent).toContain('logo-variants');
    expect(Array.from(container.querySelectorAll('.ds-project-section-title strong')).map((node) => node.textContent))
      .not.toContain('logo');
    expect(container.textContent).not.toContain('Evidence');
    expect(container.textContent).not.toContain('context/github/acme-product.md');
    expect(container.textContent).not.toContain('context/github/acme-product/files/src/components/Button.tsx');
  });

  it('maps common generated design-system project files into review sections', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[
          workspaceFile('DESIGN.md'),
          workspaceFile('README-print.md'),
          workspaceFile('preview/typography-scale.html'),
          workspaceFile('preview/colors-node-types.html'),
          workspaceFile('preview/spacing-system.html'),
          workspaceFile('ui_kits/generated_interface/index.html'),
          workspaceFile('preview/logo-variants.html'),
          workspaceFile('styles/tokens.css'),
          workspaceFile('src/components/Button.tsx'),
          workspaceFile('public/logo.svg'),
          workspaceFile('context/github/acme-product/files/src/components/ImportedButton.tsx'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );
    expect(container.textContent).toContain('Type');
    expect(container.textContent).toContain('Colors');
    expect(container.textContent).toContain('Spacing');
    expect(container.textContent).toContain('Components');
    expect(container.textContent).toContain('Brand');
    expect(container.textContent).toContain('typography-scale');
    expect(container.textContent).toContain('colors-node-types');
    expect(container.textContent).toContain('spacing-system');
    expect(container.textContent).toContain('generated-interface');
    expect(container.textContent).toContain('logo-variants');
    expect(container.textContent).not.toContain('README-print.md');
    expect(container.textContent).not.toContain('context/github/acme-product/files/src/components/ImportedButton.tsx');
  });

  it('marks sections for review when files changed after Needs work feedback', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    const colorsPreview = workspaceFile('preview/colors.html');
    colorsPreview.mtime = Date.parse('2026-05-14T00:00:03.000Z');
    const markup = renderToStaticMarkup(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), colorsPreview]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        designSystemReview={{
          colors: {
            decision: 'needs-work',
            updatedAt: '2026-05-14T00:00:00.000Z',
            feedback: 'Make the guidance more specific.',
            files: ['preview/colors.html'],
          },
        }}
      />,
    );

    expect(markup).toContain('Review updated files');
    expect(markup).toContain('This section changed after your feedback. Review it again before publishing.');
  });

  it('starts a new project from a published design system', () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'published',
      isEditable: true,
    };
    const onUseDesignSystem = vi.fn();
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        onUseDesignSystem={onUseDesignSystem}
      />,
    );
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((node) => node.textContent?.includes('New design'));
    expect(button).toBeTruthy();
    expect(button?.disabled).toBe(false);

    act(() => {
      button?.click();
    });

    expect(onUseDesignSystem).toHaveBeenCalledWith('user:acme', 'Acme Design System');
  });

  it('publishes draft design-system projects before they can become the default', async () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    registryMocks.updateDesignSystemDraft.mockResolvedValue({
      ...system,
      status: 'published',
      body: '# Acme Design System',
      swatches: [],
    });
    const onRefresh = vi.fn();
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
        onDesignSystemsRefresh={onRefresh}
      />,
    );
    const publishToggle = container.querySelector<HTMLInputElement>(
      '.ds-project-publish-card input[type="checkbox"]',
    );
    expect(publishToggle).toBeTruthy();

    await act(async () => {
      publishToggle?.click();
      await Promise.resolve();
    });

    expect(registryMocks.updateDesignSystemDraft).toHaveBeenCalledWith('user:acme', {
      status: 'published',
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it('blocks publishing GitHub-backed design systems until connector evidence exists', async () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
      provenance: {
        companyBlurb: 'Acme: analytics workspace',
        githubUrls: ['https://github.com/acme/product'],
      },
    };
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[workspaceFile('DESIGN.md'), workspaceFile('context/source-context.md'), workspaceFile('preview/colors.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );
    const publishToggle = container.querySelector<HTMLInputElement>(
      '.ds-project-publish-card input[type="checkbox"]',
    );

    expect(container.textContent).toContain('Waiting for GitHub connector evidence');
    expect(publishToggle?.disabled).toBe(true);

    await act(async () => {
      publishToggle?.click();
      await Promise.resolve();
    });

    expect(registryMocks.updateDesignSystemDraft).not.toHaveBeenCalled();
  });

  it('allows publishing GitHub-backed design systems after connector evidence snapshots exist', async () => {
    const system: DesignSystemSummary = {
      id: 'user:acme',
      title: 'Acme Design System',
      category: 'Custom',
      summary: 'Context project for Acme.',
      source: 'user',
      status: 'draft',
      isEditable: true,
      provenance: {
        companyBlurb: 'Acme: analytics workspace',
        githubUrls: ['https://github.com/acme/product'],
      },
    };
    registryMocks.updateDesignSystemDraft.mockResolvedValue({
      ...system,
      status: 'published',
      body: '# Acme Design System',
      swatches: [],
    });
    const container = renderWorkspace(
      <FileWorkspace
        projectId="ds-acme"
        files={[
          workspaceFile('DESIGN.md'),
          workspaceFile('context/source-context.md'),
          workspaceFile('context/github/acme-product.md'),
          workspaceFile('context/github/acme-product/files/src/components/Button.tsx'),
          workspaceFile('preview/colors.html'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: [], active: null }}
        onTabsStateChange={vi.fn()}
        designSystemProject={system}
      />,
    );
    const publishToggle = container.querySelector<HTMLInputElement>(
      '.ds-project-publish-card input[type="checkbox"]',
    );

    expect(container.textContent).not.toContain('Waiting for GitHub connector evidence');
    expect(publishToggle?.disabled).toBe(false);

    await act(async () => {
      publishToggle?.click();
      await Promise.resolve();
    });

    expect(registryMocks.updateDesignSystemDraft).toHaveBeenCalledWith('user:acme', {
      status: 'published',
    });
  });
});

describe('DesignFilesPanel plugin folders', () => {
  it('surfaces generated plugin folders with an install action', async () => {
    const onInstallPluginFolder = vi.fn(async () => ({
      ok: true,
      warnings: [],
      message: 'Installed Generated Plugin.',
      log: [],
    }));
    const onPublishPluginFolder = vi.fn(async () => ({
      ok: true,
      message: 'Published Generated Plugin.',
      url: 'https://github.com/acme/generated-plugin',
    }));
    const onContributePluginFolder = vi.fn(async () => ({
      ok: true,
      message: 'Prepared Open Design contribution.',
      url: 'https://github.com/nexu-io/open-design/issues/new',
    }));
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const container = renderWorkspace(
      <DesignFilesPanel
        projectId="project-1"
        files={[
          workspaceFile('generated-plugin/open-design.json'),
          workspaceFile('generated-plugin/SKILL.md'),
          workspaceFile('generated-plugin/examples/demo.md'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenLiveArtifact={vi.fn()}
        onDeleteFile={vi.fn()}
        onDeleteFiles={vi.fn()}
        onUpload={vi.fn()}
        onUploadFiles={vi.fn()}
        onPaste={vi.fn()}
        onNewSketch={vi.fn()}
        onInstallPluginFolder={onInstallPluginFolder}
        onPublishPluginFolder={onPublishPluginFolder}
        onContributePluginFolder={onContributePluginFolder}
      />,
    );

    expect(container.querySelector('[data-testid="design-plugin-folder-generated-plugin"]')).toBeTruthy();
    const install = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-plugin-folder-install-generated-plugin"]',
    );
    expect(install).toBeTruthy();
    await act(async () => {
      install?.click();
    });
    expect(onInstallPluginFolder).toHaveBeenCalledWith('generated-plugin');

    const publish = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-plugin-folder-publish-generated-plugin"]',
    );
    const contribute = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-plugin-folder-contribute-generated-plugin"]',
    );
    expect(publish).toBeTruthy();
    expect(contribute).toBeTruthy();
    await act(async () => {
      publish?.click();
    });
    expect(onPublishPluginFolder).toHaveBeenCalledWith('generated-plugin');
    expect(open).toHaveBeenCalledWith(
      'https://github.com/acme/generated-plugin',
      '_blank',
      'noopener,noreferrer',
    );
    await act(async () => {
      contribute?.click();
    });
    expect(onContributePluginFolder).toHaveBeenCalledWith('generated-plugin');
  });
});

describe('FileWorkspace tab reordering', () => {
  it('persists a dragged file tab before the tab it is dropped on', () => {
    const onTabsStateChange = vi.fn();

    const container = renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        files={[
          workspaceFile('analysis.html'),
          workspaceFile('notes.md'),
          workspaceFile('summary.html'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md', 'summary.html'],
          active: null,
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const source = getTabByName(container, /summary\.html/i);
    const target = getTabByName(container, /analysis\.html/i);
    stubTabRect(target);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(source, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(target, 'dragover', dataTransfer));
    act(() => dispatchDragEvent(target, 'drop', dataTransfer));

    expect(onTabsStateChange).toHaveBeenCalledWith({
      tabs: ['summary.html', 'analysis.html', 'notes.md'],
      active: null,
    });
  });

  it('persists a dragged file tab after the tab when dropped on its right side', () => {
    const onTabsStateChange = vi.fn();

    const container = renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        files={[
          workspaceFile('analysis.html'),
          workspaceFile('notes.md'),
          workspaceFile('summary.html'),
        ]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md', 'summary.html'],
          active: null,
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const source = getTabByName(container, /analysis\.html/i);
    const target = getTabByName(container, /summary\.html/i);
    stubTabRect(target);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(source, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(target, 'drop', dataTransfer, 75));

    expect(onTabsStateChange).toHaveBeenCalledWith({
      tabs: ['notes.md', 'summary.html', 'analysis.html'],
      active: null,
    });
  });

  it('does not persist when a tab is dropped on itself', () => {
    const onTabsStateChange = vi.fn();

    const container = renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.md')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md'],
          active: null,
        }}
        onTabsStateChange={onTabsStateChange}
      />,
    );

    const tab = getTabByName(container, /analysis\.html/i);
    stubTabRect(tab);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(tab, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(tab, 'drop', dataTransfer));

    expect(onTabsStateChange).not.toHaveBeenCalled();
  });

  it('clears the drop indicator when the drag leaves the tab bar', () => {
    const container = renderWorkspace(
      <FileWorkspace
        projectId="project-1"
        files={[workspaceFile('analysis.html'), workspaceFile('notes.md')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{
          tabs: ['analysis.html', 'notes.md'],
          active: null,
        }}
        onTabsStateChange={vi.fn()}
      />,
    );

    const source = getTabByName(container, /analysis\.html/i);
    const target = getTabByName(container, /notes\.md/i);
    const tabBar = container.querySelector<HTMLElement>('.ws-tabs-bar');
    if (!tabBar) throw new Error('Could not find tabs bar');
    stubTabRect(target);

    let dataTransfer = createDragDataTransfer();
    act(() => {
      dataTransfer = dispatchDragEvent(source, 'dragstart', dataTransfer);
    });
    act(() => dispatchDragEvent(target, 'dragover', dataTransfer));

    expect(target.className).toContain('drag-over-before');

    act(() => dispatchDragEvent(tabBar, 'dragleave', dataTransfer, 0, document.body));

    expect(target.className).not.toContain('drag-over-before');
    expect(target.className).not.toContain('drag-over-after');
  });
});

describe('projectSplitClassName', () => {
  it('marks the project split as focused so the chat pane can collapse globally', () => {
    expect(projectSplitClassName(false)).toBe('split');
    expect(projectSplitClassName(true)).toBe('split split-focus');
  });
});

describe('scrollWorkspaceTabsWithWheel', () => {
  function makeTabBar(scrollLeft: number, scrollWidth = 400, clientWidth = 200) {
    return { scrollLeft, scrollWidth, clientWidth } as HTMLDivElement;
  }

  function makeClampedTabBar(scrollLeft: number, scrollWidth = 400, clientWidth = 200) {
    let value = scrollLeft;
    return {
      scrollWidth,
      clientWidth,
      get scrollLeft() {
        return value;
      },
      set scrollLeft(next: number) {
        value = Math.min(Math.max(next, 0), scrollWidth - clientWidth);
      },
    } as HTMLDivElement;
  }

  it('maps vertical mouse wheel movement to horizontal tab scrolling', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(52);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('supports reverse vertical wheel movement', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(52);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: -40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('normalizes line-based wheel deltas to useful pixel movement', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: false,
      deltaMode: 1,
      deltaX: 0,
      deltaY: 3,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(60);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('normalizes page-based wheel deltas to useful pixel movement', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12, 600, 200);
    const event = {
      ctrlKey: false,
      deltaMode: 2,
      deltaX: 0,
      deltaY: 1,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(172);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves native horizontal wheel gestures alone', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 50,
      deltaY: 10,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('leaves ctrl-wheel zoom gestures alone', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12);
    const event = {
      ctrlKey: true,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not intercept vertical wheel movement when tabs do not overflow', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeTabBar(12, 200, 200);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(12);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('lets page scrolling continue when the tab bar is already at the wheel boundary', () => {
    const preventDefault = vi.fn();
    const currentTarget = makeClampedTabBar(200, 400, 200);
    const event = {
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 40,
      preventDefault,
    } as unknown as WheelEvent;

    scrollWorkspaceTabsWithWheel(currentTarget, event);

    expect(currentTarget.scrollLeft).toBe(200);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
