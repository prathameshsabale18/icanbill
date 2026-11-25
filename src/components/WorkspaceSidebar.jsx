import React from 'react';
import {
  FileSpreadsheet,
  LayoutDashboard,
  HardDrive,
  Settings,
  ShoppingBasket,
  UsersRound,
  ClipboardList,
  WalletCards,
  Archive,
  FileStack,
} from 'lucide-react';

export default function WorkspaceSidebar({ activeView, onNavigate, workspaceMode = 'business' }) {
  const commonItems = [
    { id: 'overview', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'clients', label: 'Clients', icon: UsersRound },
    { id: 'billing', label: 'Billing', icon: FileSpreadsheet },
    { id: 'payments', label: 'Payments', icon: WalletCards },
    { id: 'organizer', label: 'Organizer', icon: Archive },
    { id: 'generator', label: 'Invoice Generator', icon: FileSpreadsheet },
  ];
  const modeItems = workspaceMode === 'retail'
    ? [{ id: 'retail', label: 'Retail billing', icon: ShoppingBasket }]
    : [
        { id: 'purchase-orders', label: 'Purchase orders', icon: ClipboardList },
        { id: 'quotations', label: 'Quotations', icon: FileStack },
      ];
  const items = [...commonItems, ...modeItems];

  return (
    <aside className="workspace-sidebar">
      <div className="workspace-sidebar-header">
        <div className="workspace-brand-mark">
          <img src="/logo.svg" alt="" />
        </div>
        <div className="workspace-brand-copy">
          <strong>iCanBill</strong>
          <span>Billing workspace</span>
        </div>
      </div>
      <div className="workspace-sidebar-section">Workspace</div>
      <nav className="workspace-nav" aria-label="Workspace navigation">
        {items.map(({ id, label, icon: Icon }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              className={`workspace-nav-item${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      <div className="workspace-sidebar-footer">
        <div className="workspace-local-card">
          <HardDrive size={17} />
          <span>
            <strong>Stored in this browser</strong>
            <small>Billing data is not synced yet</small>
          </span>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className={`workspace-nav-item${activeView === 'settings' ? ' active' : ''}`}
          aria-current={activeView === 'settings' ? 'page' : undefined}
        >
          <Settings size={18} strokeWidth={1.8} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
