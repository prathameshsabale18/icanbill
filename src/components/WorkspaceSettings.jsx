import React from 'react';
import { BriefcaseBusiness, Store } from 'lucide-react';
import WorkspaceSidebar from './WorkspaceSidebar';

const modes = [
  {
    id: 'retail',
    title: 'Retail Mode',
    description: 'Fast barcode checkout, product search, and stock management.',
    icon: Store,
  },
  {
    id: 'business',
    title: 'Business Mode',
    description: 'Customer work, order tracking, and AI-assisted PO-to-invoice creation.',
    icon: BriefcaseBusiness,
  },
];

export default function WorkspaceSettings({
  workspaceMode,
  onWorkspaceModeChange,
  onNavigate,
}) {
  return (
    <div className="workspace-settings-shell">
      <WorkspaceSidebar
        activeView="settings"
        onNavigate={onNavigate}
        workspaceMode={workspaceMode}
      />
      <main className="workspace-settings-main">
        <div style={{ maxWidth: '900px', margin: '0 auto' }}>
          <div style={{ marginBottom: '24px' }}>
            <div style={{ color: '#087d73', fontSize: '11px', fontWeight: 800, letterSpacing: '.08em' }}>
              ICANBILL / PREFERENCES
            </div>
            <h1 style={{ margin: '8px 0', color: '#172033', fontSize: '28px' }}>Workspace settings</h1>
            <p style={{ margin: 0, color: '#687486' }}>
              Choose the tools shown for your business. Switching modes keeps your customers, products, orders, and invoices unchanged.
            </p>
          </div>
          <section aria-labelledby="workspace-mode-heading" style={{ padding: '24px', border: '1px solid #e3e9ef', borderRadius: '14px', background: '#fff' }}>
            <h2 id="workspace-mode-heading" style={{ margin: '0 0 6px', color: '#172033', fontSize: '18px' }}>Workspace mode</h2>
            <p style={{ margin: '0 0 18px', color: '#788496', fontSize: '13px' }}>You can switch modes at any time from Settings.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
              {modes.map(({ id, title, description, icon: Icon }) => {
                const selected = workspaceMode === id;
                return (
                  <label
                    key={id}
                    style={{
                      display: 'flex',
                      gap: '14px',
                      alignItems: 'flex-start',
                      padding: '18px',
                      border: `1px solid ${selected ? '#087d73' : '#e3e9ef'}`,
                      borderRadius: '11px',
                      background: selected ? '#f0faf8' : '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="workspace_mode"
                      value={id}
                      checked={selected}
                      onChange={() => onWorkspaceModeChange(id)}
                      style={{ marginTop: '3px', accentColor: '#087d73' }}
                    />
                    <Icon size={20} color={selected ? '#087d73' : '#657184'} />
                    <span>
                      <strong style={{ display: 'block', marginBottom: '5px', color: '#172033', fontSize: '14px' }}>{title}</strong>
                      <span style={{ display: 'block', color: '#788496', fontSize: '12px', lineHeight: 1.5 }}>{description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div role="status" style={{ marginTop: '18px', color: '#087d73', fontSize: '12px', fontWeight: 600 }}>
              Current mode: {workspaceMode === 'retail' ? 'Retail' : 'Business'}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
