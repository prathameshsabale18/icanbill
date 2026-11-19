import React, { useEffect, useMemo, useState } from 'react';
import { Archive, FileText, Search } from 'lucide-react';
import { localData } from '../localDataClient';
import WorkspaceSidebar from './WorkspaceSidebar';

const ORDER_KEY = 'billing_mvp_client_orders';
const FILTERS = ['All', 'Invoices', 'Purchase orders', 'Quotations', 'Customers', 'Documents', 'Requirements'];

export default function OrganizerDashboard({ onNavigate, workspaceMode }) {
  const [records, setRecords] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const results = await Promise.all([
        localData.from('invoices').select('*'),
        localData.from('purchase_orders').select('*'),
        localData.from('quotations').select('*'),
        localData.from('clients').select('*'),
        localData.from('documents').select('*'),
      ]);
      const failed = results.find(result => result.error);
      if (failed) throw new Error(failed.error.message);
      const [invoices, purchaseOrders, quotations, clients, documents] = results.map(result => result.data || []);
      let requirements = [];
      try {
        const stored = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
        if (Array.isArray(stored)) requirements = stored;
      } catch {
        throw new Error('Stored requirements are not valid JSON.');
      }
      const rows = [
        ...invoices.map(row => ({
          id: `invoice-${row.id}`, kind: 'Invoices', title: row.invoice_no || `Invoice #${row.id}`,
          detail: row.client_name || 'Unnamed customer', date: row.date || row.created_at,
          amount: row.grand_total ?? row.amount, navigate: 'billing',
        })),
        ...purchaseOrders.map(row => ({
          id: `po-${row.id}`, kind: 'Purchase orders', title: row.po_no || `PO #${row.id}`,
          detail: row.party_name || row.client_name || row.supplier_name || 'Unnamed party',
          date: row.po_date || row.date, amount: row.total, navigate: 'purchase-orders',
        })),
        ...quotations.map(row => ({
          id: `quote-${row.id}`, kind: 'Quotations', title: row.quotation_no || `Quotation #${row.id}`,
          detail: `${row.client_name || 'Unnamed customer'} · ${row.status || 'Draft'}`,
          date: row.date || row.created_at, amount: row.amount, navigate: 'quotations',
        })),
        ...clients.map(row => ({
          id: `client-${row.id}`, kind: 'Customers', title: row.client_name || 'Unnamed customer',
          detail: [row.email, row.phone].filter(Boolean).join(' · ') || 'Customer profile',
          date: row.updated_at || row.created_at, navigate: 'clients',
        })),
        ...documents.map(row => ({
          id: `document-${row.id}`, kind: 'Documents', title: row.file_name || row.name || 'Document',
          detail: row.document_type || 'Saved document', date: row.created_at,
          navigate: row.purchase_order_id ? 'purchase-orders' : 'organizer',
        })),
        ...requirements.map(row => ({
          id: `requirement-${row.id}`, kind: 'Requirements', title: row.requirement || 'Requirement',
          detail: row.notes || row.status || 'Business requirement',
          date: row.createdAt, navigate: 'clients',
        })),
      ];
      rows.sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
      setRecords(rows);
      setNotice('');
    } catch (error) {
      setNotice(`Could not load organizer records: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);

  const visibleRecords = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return records.filter(record =>
      (filter === 'All' || record.kind === filter) &&
      (!needle || [record.title, record.detail, record.kind, record.date]
        .some(value => String(value || '').toLowerCase().includes(needle)))
    );
  }, [records, search, filter]);

  return (
    <div className="organizer-shell">
      <WorkspaceSidebar activeView="organizer" onNavigate={onNavigate} workspaceMode={workspaceMode} />
      <main className="organizer-main">
        <header><div><span>ICANBILL / RECORDS</span><h1>Organizer</h1><p>Search your invoices, orders, quotations, customers, and saved documents.</p></div><button type="button" onClick={refresh}>Refresh</button></header>
        {notice && <p className="organizer-notice" role="alert">{notice}</p>}
        <section className="organizer-card">
          <div className="organizer-tools"><label><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search records" /></label><select aria-label="Filter record type" value={filter} onChange={event => setFilter(event.target.value)}>{FILTERS.map(value => <option key={value}>{value}</option>)}</select></div>
          {loading ? <p className="organizer-empty">Loading records…</p> : visibleRecords.length === 0
            ? <div className="organizer-empty"><Archive size={24} /><strong>{records.length ? 'No matching records' : 'No records yet'}</strong><span>Records from your shared workspace will appear here.</span></div>
            : <div className="organizer-list">{visibleRecords.map(record => <button type="button" className="organizer-row" key={record.id} onClick={() => record.navigate !== 'organizer' && onNavigate(record.navigate)}><span className="organizer-icon"><FileText size={17} /></span><span className="organizer-copy"><strong>{record.title}</strong><small>{record.kind} · {record.detail}</small></span><span className="organizer-meta">{record.date || '—'}{record.amount !== undefined && record.amount !== null && <strong>Rs. {Number(record.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>}</span></button>)}</div>}
        </section>
      </main>
      <style>{styles}</style>
    </div>
  );
}

const styles = `
.organizer-shell{display:flex;min-height:calc(100vh - 68px);background:#f7f9fc;color:#243347}.organizer-main{flex:1;min-width:0;padding:32px 36px 48px}.organizer-main>header{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:22px}.organizer-main>header span{color:#087d73;font-size:10px;font-weight:800;letter-spacing:1px}.organizer-main>header h1{margin:7px 0;color:#203043;font-size:27px}.organizer-main>header p{margin:0;color:#7b8795;font-size:13px}.organizer-main>header button{height:36px;padding:0 12px;border:1px solid #dfe7ea;border-radius:8px;background:#fff;color:#405366;font-size:11px;font-weight:700;cursor:pointer}.organizer-notice{padding:10px 12px;border-radius:8px;background:#fff3f1;color:#aa4038;font-size:12px}.organizer-card{border:1px solid #e6eaed;border-radius:13px;background:#fff;box-shadow:0 7px 22px #25354a08;overflow:hidden}.organizer-tools{display:flex;gap:10px;padding:14px;border-bottom:1px solid #edf0f2}.organizer-tools label{display:flex;align-items:center;gap:8px;flex:1;padding:0 10px;border:1px solid #e3e8eb;border-radius:7px;color:#8b96a2}.organizer-tools input{width:100%;height:35px;border:0;outline:0;font:inherit;font-size:12px}.organizer-tools select{height:37px;padding:0 10px;border:1px solid #e1e7ea;border-radius:7px;background:#fff;color:#435368;font-size:11px}.organizer-list{display:grid}.organizer-row{display:flex;align-items:center;gap:11px;width:100%;padding:13px 15px;border:0;border-bottom:1px solid #f0f2f4;background:#fff;text-align:left;cursor:pointer}.organizer-row:hover{background:#fbfdfd}.organizer-icon{display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:9px;background:#eaf6f3;color:#087d73}.organizer-copy{display:grid;flex:1;min-width:0;gap:4px}.organizer-copy strong{overflow:hidden;color:#324358;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.organizer-copy small{overflow:hidden;color:#8693a0;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.organizer-meta{display:grid;gap:4px;color:#8994a1;font-size:10px;text-align:right}.organizer-meta strong{color:#34465b;font-size:11px}.organizer-empty{min-height:220px;display:grid;place-content:center;justify-items:center;gap:8px;color:#8f9aa6;font-size:12px}.organizer-empty strong{color:#526174;font-size:14px}@media(max-width:720px){.organizer-main{padding:22px 15px 35px}.organizer-main>header{align-items:flex-start;flex-direction:column}.organizer-tools{flex-direction:column}.organizer-meta{max-width:90px;white-space:nowrap}.organizer-meta strong{overflow:hidden;text-overflow:ellipsis}}
`;
