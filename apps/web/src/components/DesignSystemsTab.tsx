import { useMemo, useState } from 'react';
import { deleteDesignSystemDraft, updateDesignSystemDraft } from '../providers/registry';
import type { DesignSystemSummary } from '../types';
import { Icon } from './Icon';

interface Props {
  systems: DesignSystemSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onOpenSystem: (id: string) => void;
  onSystemsRefresh?: () => Promise<void> | void;
}

type ListFilter = 'all' | 'published' | 'draft';

function isUserSystem(system: DesignSystemSummary): boolean {
  return system.source === 'user' || system.isEditable === true;
}

function formatShortDate(value: string | undefined): string {
  if (!value) return 'just now';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

export function DesignSystemsTab({
  systems,
  selectedId,
  onSelect,
  onCreate,
  onOpenSystem,
  onSystemsRefresh,
}: Props) {
  const [filter, setFilter] = useState<ListFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const userSystems = useMemo(() => {
    const editable = systems.filter(isUserSystem);
    if (filter === 'all') return editable;
    return editable.filter((system) => (system.status ?? 'draft') === filter);
  }, [systems, filter]);

  async function refreshSystems() {
    await onSystemsRefresh?.();
  }

  async function togglePublished(system: DesignSystemSummary) {
    setBusyId(system.id);
    try {
      await updateDesignSystemDraft(system.id, {
        status: system.status === 'published' ? 'draft' : 'published',
      });
      await refreshSystems();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteSystem(system: DesignSystemSummary) {
    const ok = window.confirm(`Delete "${system.title}"? This removes the draft design system from this device.`);
    if (!ok) return;
    setBusyId(system.id);
    try {
      const deleted = await deleteDesignSystemDraft(system.id);
      if (!deleted) return;
      if (selectedId === system.id) {
        const fallback = systems.find((s) => s.id !== system.id && isUserSystem(s));
        if (fallback) onSelect(fallback.id);
      }
      await refreshSystems();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="tab-panel ds-settings-page">
      <section className="ds-settings-card" aria-label="Design Systems">
        <div className="ds-settings-card__head">
          <div>
            <span className="ds-manager-eyebrow">Design Systems</span>
            <h2>Design systems</h2>
          </div>
          <select
            aria-label="Filter design systems"
            value={filter}
            onChange={(event) => setFilter(event.target.value as ListFilter)}
          >
            <option value="all">All</option>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
          </select>
        </div>

        <button type="button" className="ds-create-row" onClick={onCreate}>
          <span>
            <strong>Create new design system</strong>
            <small>Teach Open Design your brand, product, code, assets, and design references.</small>
          </span>
          <span className="ds-create-row__action">Create</span>
        </button>

        {userSystems.length === 0 ? (
          <div className="ds-user-empty">
            No design systems yet. Create one from real product context, review the draft, then publish it for future projects.
          </div>
        ) : (
          <div className="ds-user-list">
            {userSystems.map((system) => {
              const status = system.status ?? 'draft';
              const canUseInProjects = status === 'published';
              const selected = canUseInProjects && system.id === selectedId;
              const busy = busyId === system.id;
              return (
                <div className="ds-user-row" key={system.id}>
                  <button
                    type="button"
                    className="ds-user-row__open"
                    onClick={() => onOpenSystem(system.id)}
                  >
                    <span className="ds-user-row__title">
                      <span>{system.title}</span>
                      {selected ? <span className="ds-card-badge">Default</span> : null}
                    </span>
                    <span className="ds-user-row__meta">
                      You · updated {formatShortDate(system.updatedAt)}
                    </span>
                  </button>
                  <div className="ds-user-row__actions">
                    {!selected && canUseInProjects ? (
                      <button
                        type="button"
                        className="ghost compact"
                        onClick={() => onSelect(system.id)}
                        disabled={busy}
                      >
                        Make default
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`ds-status-toggle ${status === 'published' ? 'is-on' : ''}`}
                      aria-pressed={status === 'published'}
                      onClick={() => void togglePublished(system)}
                      disabled={busy}
                    >
                      <span>{status === 'published' ? 'Published' : 'Draft'}</span>
                      <i aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Open ${system.title}`}
                      onClick={() => onOpenSystem(system.id)}
                    >
                      <Icon name="external-link" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={`Delete ${system.title}`}
                      onClick={() => void deleteSystem(system)}
                      disabled={busy}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="ds-settings-card ds-templates-card" aria-label="Templates">
        <div className="ds-settings-card__head">
          <div>
            <span className="ds-manager-eyebrow">Templates</span>
            <h2>Templates</h2>
          </div>
        </div>
        <div className="ds-user-empty">
          No templates yet. Create one from any generated project via Share once template publishing is enabled.
        </div>
      </section>

      <p className="ds-private-note">Only you can view these settings.</p>
    </div>
  );
}
