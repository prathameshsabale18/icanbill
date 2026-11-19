import React, { useEffect, useMemo, useState } from 'react';
import { FilePlus2, FileText, Plus, Search, X } from 'lucide-react';
import { localData } from '../localDataClient';
import WorkspaceSidebar from './WorkspaceSidebar';

const STATUSES = ['Draft', 'Sent', 'Approved', 'Rejected', 'Invoiced'];
const emptyItem = () => ({ description: '', quantity: '1', unit_price: '', dimensions: '', specifications: '' });
const today = () => new Date().toISOString().slice(0, 10);
const money = value => `Rs. ${Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;
const nextId = rows => rows.reduce((maximum, row) =>
  Number.isFinite(Number(row.id)) ? Math.max(maximum, Number(row.id)) : maximum
, 0) + 1;
const quoteTotal = items => items.reduce((total, item) =>
  total + Math.max(0, Number(item.quantity) || 0) * Math.max(0, Number(item.unit_price) || 0)
, 0);

export default function QuotationsDashboard({ onNavigate, workspaceMode, onCreateInvoice }) {
  const [quotes, setQuotes] = useState([]);
  const [quoteItems, setQuoteItems] = useState({});
  const [clients, setClients] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    try {
      const [quoteResult, itemResult, clientResult] = await Promise.all([
        localData.from('quotations').select('*').order('created_at', { ascending: false }),
        localData.from('quotation_items').select('*'),
        localData.from('clients').select('*').order('client_name', { ascending: true }),
      ]);
      for (const result of [quoteResult, itemResult, clientResult]) {
        if (result.error) throw new Error(result.error.message);
      }
      const byQuote = (itemResult.data || []).reduce((result, item) => {
        (result[item.quotation_id] ||= []).push(item);
        return result;
      }, {});
      setQuotes(quoteResult.data || []);
      setQuoteItems(byQuote);
      setClients(clientResult.data || []);
    } catch (error) {
      setNotice(`Could not load quotations: ${error.message}`);
    }
  };
  useEffect(() => { refresh(); }, []);

  const visibleQuotes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return quotes.filter(quote =>
      (filter === 'All' || quote.status === filter) &&
      (!needle || [quote.quotation_no, quote.client_name, quote.status]
        .some(value => String(value || '').toLowerCase().includes(needle)))
    );
  }, [quotes, search, filter]);

  const newQuote = () => setForm({
    clientId: '',
    quotationNo: `QT-${String(quotes.length + 1).padStart(4, '0')}`,
    date: today(),
    validUntil: '',
    status: 'Draft',
    items: [emptyItem()],
  });
  const updateItem = (index, key, value) => setForm(current => ({
    ...current,
    items: current.items.map((item, itemIndex) =>
      itemIndex === index ? { ...item, [key]: value } : item
    ),
  }));
  const save = async event => {
    event.preventDefault();
    if (!form || saving) return;
    const client = clients.find(row => String(row.id) === String(form.clientId));
    if (!client) {
      setNotice('Select a customer before saving the quotation.');
      return;
    }
    if (!form.quotationNo.trim() || !form.date || !form.items.length || form.items.some(item =>
      !item.description.trim() ||
      !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 ||
      !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0
    )) {
      setNotice('Enter a quotation number, date, and valid description, quantity, and price for each item.');
      return;
    }
    setSaving(true);
    setNotice('');
    const now = new Date().toISOString();
    const result = await localData.atomic(database => {
      const quotationNo = form.quotationNo.trim();
      if (database.quotations.some(quote =>
        String(quote.quotation_no || '').trim().toLowerCase() === quotationNo.toLowerCase()
      )) {
        throw new Error(`Quotation number already exists: ${quotationNo}`);
      }
      const quoteId = nextId(database.quotations);
      const items = form.items.map(item => ({
        id: 0,
        quotation_id: quoteId,
        description: item.description.trim(),
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        dimensions: item.dimensions.trim(),
        specifications: item.specifications.trim(),
        subtotal: Number(item.quantity) * Number(item.unit_price),
        created_at: now,
        updated_at: now,
      }));
      const total = quoteTotal(items);
      database.quotations.push({
        id: quoteId,
        quotation_no: quotationNo,
        client_id: client.id,
        client_name: client.client_name,
        date: form.date,
        valid_until: form.validUntil || '',
        status: form.status,
        amount: total,
        subtotal: total,
        created_at: now,
        updated_at: now,
      });
      items.forEach(item => {
        item.id = nextId(database.quotation_items);
        database.quotation_items.push(item);
      });
      return quoteId;
    });
    if (result.error) {
      setNotice(`Could not save quotation: ${result.error.message}`);
      setSaving(false);
      return;
    }
    setForm(null);
    await refresh();
    setNotice('Quotation saved.');
    setSaving(false);
  };

  const changeStatus = async (quote, status) => {
    if (quote.invoice_id) return;
    const result = await localData.from('quotations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', quote.id);
    if (result.error) setNotice(`Could not update quotation: ${result.error.message}`);
    else await refresh();
  };

  const startInvoice = async quote => {
    if (quote.invoice_id) {
      setNotice('An invoice has already been created for this quotation.');
      return;
    }
    try {
      await onCreateInvoice({ ...quote, items: quoteItems[quote.id] || [] });
    } catch (error) {
      setNotice(`Could not start an invoice: ${error.message}`);
    }
  };

  return <>
    <div className="quotes-shell">
      <WorkspaceSidebar activeView="quotations" onNavigate={onNavigate} workspaceMode={workspaceMode} />
      <main className="quotes-main">
        <header className="quotes-header"><div><span>ICANBILL / BUSINESS</span><h1>Quotations</h1><p>Prepare customer pricing and convert approved quotations into invoice drafts.</p></div><button className="quotes-primary" onClick={newQuote}><Plus size={15} /> New quotation</button></header>
        {notice && <div className="quotes-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={14} /></button></div>}
        <section className="quotes-card">
          <div className="quotes-toolbar"><label><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search number or customer" /></label><select value={filter} onChange={event => setFilter(event.target.value)} aria-label="Filter quotations">{['All', ...STATUSES].map(status => <option key={status}>{status}</option>)}</select></div>
          {visibleQuotes.length === 0 ? <div className="quotes-empty"><FileText size={25} /><strong>{quotes.length ? 'No matching quotations' : 'No quotations yet'}</strong><span>Create a quotation to organize proposed work and pricing.</span></div>
            : <div className="quotes-table-wrap"><table><thead><tr><th>Quotation</th><th>Customer</th><th>Date</th><th>Valid until</th><th>Items</th><th>Amount</th><th>Status</th><th /></tr></thead><tbody>
              {visibleQuotes.map(quote => {
                const items = quoteItems[quote.id] || [];
                return <tr key={quote.id}><td><strong>{quote.quotation_no}</strong>{quote.invoice_id && <small>Invoice linked</small>}</td><td>{quote.client_name}</td><td>{quote.date || '—'}</td><td>{quote.valid_until || '—'}</td><td>{items.length}</td><td><strong>{money(quote.amount)}</strong></td><td><select value={quote.status || 'Draft'} disabled={Boolean(quote.invoice_id)} onChange={event => changeStatus(quote, event.target.value)} aria-label={`Status for ${quote.quotation_no}`}>{STATUSES.filter(status => status !== 'Invoiced' || quote.status === 'Invoiced').map(status => <option key={status}>{status}</option>)}</select></td><td>{quote.status === 'Approved' && !quote.invoice_id && <button className="quotes-convert" onClick={() => startInvoice(quote)}><FilePlus2 size={14} /> Create invoice</button>}</td></tr>;
              })}
            </tbody></table></div>}
        </section>
      </main>
    </div>
    {form && <div className="quotes-backdrop" onMouseDown={event => event.target === event.currentTarget && !saving && setForm(null)}>
      <form className="quotes-modal" onSubmit={save}>
        <header><div><span>NEW QUOTATION</span><h2>Create a quotation</h2></div><button type="button" onClick={() => setForm(null)} aria-label="Close"><X size={18} /></button></header>
        <div className="quotes-row"><label>Customer<select required value={form.clientId} onChange={event => setForm(current => ({ ...current, clientId: event.target.value }))}><option value="">Select a customer</option>{clients.map(client => <option key={client.id} value={client.id}>{client.client_name}</option>)}</select></label><label>Quotation number<input required value={form.quotationNo} onChange={event => setForm(current => ({ ...current, quotationNo: event.target.value }))} /></label></div>
        <div className="quotes-row"><label>Date<input required type="date" value={form.date} onChange={event => setForm(current => ({ ...current, date: event.target.value }))} /></label><label>Valid until<input type="date" value={form.validUntil} onChange={event => setForm(current => ({ ...current, validUntil: event.target.value }))} /></label></div>
        <label>Status<select value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value }))}>{STATUSES.filter(status => status !== 'Invoiced').map(status => <option key={status}>{status}</option>)}</select></label>
        <div className="quotes-items-head"><strong>Line items</strong><button type="button" onClick={() => setForm(current => ({ ...current, items: [...current.items, emptyItem()] }))}><Plus size={14} /> Add item</button></div>
        <div className="quotes-items">{form.items.map((item, index) => <div className="quotes-item" key={index}><label>Description<input required value={item.description} onChange={event => updateItem(index, 'description', event.target.value)} /></label><div className="quotes-row"><label>Quantity<input required type="number" min="0.001" step="any" value={item.quantity} onChange={event => updateItem(index, 'quantity', event.target.value)} /></label><label>Unit price<input required type="number" min="0" step="0.01" value={item.unit_price} onChange={event => updateItem(index, 'unit_price', event.target.value)} /></label></div><div className="quotes-row"><label>Dimensions<input value={item.dimensions} onChange={event => updateItem(index, 'dimensions', event.target.value)} /></label><label>Specifications<input value={item.specifications} onChange={event => updateItem(index, 'specifications', event.target.value)} /></label></div>{form.items.length > 1 && <button type="button" className="quotes-remove" onClick={() => setForm(current => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}>Remove item</button>}</div>)}</div>
        <div className="quotes-total"><span>Subtotal</span><strong>{money(quoteTotal(form.items))}</strong></div>
        <footer><button type="button" className="quotes-secondary" disabled={saving} onClick={() => setForm(null)}>Cancel</button><button className="quotes-primary" disabled={saving}>{saving ? 'Saving…' : 'Save quotation'}</button></footer>
      </form>
    </div>}
    <style>{styles}</style>
  </>;
}

const styles = `
.quotes-shell{display:flex;min-height:calc(100vh - 68px);background:#f7f9fc;color:#243347}.quotes-main{flex:1;min-width:0;padding:32px 36px 48px}.quotes-header{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:22px}.quotes-header span,.quotes-modal header span{color:#087d73;font-size:10px;font-weight:800;letter-spacing:1px}.quotes-header h1{margin:7px 0;color:#203043;font-size:27px}.quotes-header p{margin:0;color:#7b8795;font-size:13px}.quotes-primary,.quotes-secondary,.quotes-convert{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid #087d73;border-radius:8px;background:#087d73;color:#fff;font-size:11px;font-weight:700;cursor:pointer}.quotes-secondary{border-color:#dfe7ea;background:#fff;color:#405366}.quotes-primary:disabled{opacity:.6;cursor:wait}.quotes-notice{display:flex;justify-content:space-between;margin-bottom:14px;padding:11px 13px;border-radius:8px;background:#effaf7;color:#087d73;font-size:12px}.quotes-notice button{border:0;background:transparent;color:inherit;cursor:pointer}.quotes-card{border:1px solid #e6eaed;border-radius:13px;background:#fff;box-shadow:0 7px 22px #25354a08;overflow:hidden}.quotes-toolbar{display:flex;gap:10px;padding:14px;border-bottom:1px solid #edf0f2}.quotes-toolbar label{display:flex;align-items:center;gap:8px;flex:1;padding:0 10px;border:1px solid #e3e8eb;border-radius:7px;color:#8b96a2}.quotes-toolbar input{width:100%;height:34px;border:0;outline:0;font:inherit;font-size:12px}.quotes-toolbar select,.quotes-table select{height:36px;padding:0 9px;border:1px solid #e1e7ea;border-radius:7px;background:#fff;color:#435368;font-size:11px}.quotes-table-wrap{overflow:auto}.quotes-table-wrap table{width:100%;border-collapse:collapse;text-align:left;font-size:11px}.quotes-table-wrap th{padding:11px 13px;background:#fafbfc;color:#8994a1;font-size:9px;text-transform:uppercase;white-space:nowrap}.quotes-table-wrap td{padding:12px 13px;border-top:1px solid #f0f2f4;color:#59697a;white-space:nowrap}.quotes-table-wrap td strong{color:#26364a}.quotes-table-wrap td small{display:block;color:#087d73;font-size:9px}.quotes-convert{min-height:30px;padding:0 8px;white-space:nowrap}.quotes-empty{min-height:220px;display:grid;place-content:center;justify-items:center;gap:8px;color:#8f9aa6;font-size:12px}.quotes-empty strong{color:#526174;font-size:14px}.quotes-backdrop{position:fixed;inset:0;z-index:600;display:grid;place-items:center;padding:15px;background:#17233380}.quotes-modal{width:min(760px,100%);max-height:92vh;overflow-y:auto;padding:20px;border-radius:14px;background:#fff;box-shadow:0 22px 65px #13203340}.quotes-modal header{display:flex;justify-content:space-between;margin-bottom:15px}.quotes-modal header h2{margin:5px 0;color:#27374b;font-size:19px}.quotes-modal header button{width:30px;height:30px;border:0;border-radius:7px;background:#f4f6f7;color:#677587;font-size:18px;cursor:pointer}.quotes-modal label{display:grid;gap:6px;margin-top:10px;color:#526174;font-size:10px;font-weight:700}.quotes-modal input,.quotes-modal select{width:100%;min-width:0;height:36px;padding:0 9px;border:1px solid #e0e6e9;border-radius:7px;background:#fff;color:#2c3d50;font:inherit;font-size:11px}.quotes-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.quotes-items-head{display:flex;align-items:center;justify-content:space-between;margin:17px 0 8px;color:#34465b;font-size:12px}.quotes-items-head button{display:inline-flex;align-items:center;gap:5px;padding:6px 9px;border:1px solid #dfe7ea;border-radius:7px;background:#fff;color:#405366;font-size:10px;cursor:pointer}.quotes-items{display:grid;gap:8px}.quotes-item{padding:11px;border:1px solid #e7ecee;border-radius:8px;background:#fbfcfc}.quotes-remove{margin-top:7px;border:0;background:transparent;color:#a84840;font-size:10px;cursor:pointer}.quotes-total{display:flex;justify-content:space-between;margin-top:15px;padding:12px;border-radius:8px;background:#f1f8f6;color:#546879;font-size:11px}.quotes-total strong{color:#087d73}.quotes-modal footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}@media(max-width:720px){.quotes-main{padding:22px 15px 35px}.quotes-header{align-items:flex-start;flex-direction:column}.quotes-modal{max-height:96vh}.quotes-row{grid-template-columns:1fr}.quotes-table-wrap table{min-width:720px}}
`;
