import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine, FilePlus2, FileText, Image, LoaderCircle, Pencil,
  Plus, Search, Trash2, Upload, X
} from 'lucide-react';
import { localData } from '../localDataClient';
import WorkspaceSidebar from './WorkspaceSidebar';

const STATUSES = ['Received', 'Processing', 'Approved', 'Completed', 'Cancelled'];
const emptyItem = () => ({
  description: '', quantity: '1', dimensions: '', specifications: '',
  unit_price: '', tax_rate: ''
});
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const nextId = rows => rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
const partyLabel = (party, type) => party?.[type === 'customer' ? 'client_name' : 'supplier_name'] || party?.name || '';
const money = value => `Rs. ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const itemTotals = items => items.reduce((total, item) => {
  const line = Math.max(0, Number(item.quantity) || 0) * Math.max(0, Number(item.unit_price) || 0);
  return total + line + line * (Math.max(0, Number(item.tax_rate) || 0) / 100);
}, 0);
const makeNewForm = count => ({
  partyType: 'customer',
  poNo: `PO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`,
  poDate: localDate(),
  partyId: '',
  partyName: '',
  status: 'Received',
  items: [emptyItem()],
  attachments: []
});
const localIdEquals = (left, right) => String(left) === String(right);

export default function PurchaseOrdersDashboard({ onCreateInvoice, onNavigate, workspaceMode = 'business' }) {
  const [orders, setOrders] = useState([]);
  const [itemsByOrder, setItemsByOrder] = useState({});
  const [clients, setClients] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [documentsByOrder, setDocumentsByOrder] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [form, setForm] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = async () => {
    try {
      const results = await Promise.all([
        localData.from('purchase_orders').select('*').order('created_at', { ascending: false }),
        localData.from('purchase_order_items').select('*'),
        localData.from('clients').select('*').order('client_name', { ascending: true }),
        localData.from('suppliers').select('*').order('supplier_name', { ascending: true }),
        localData.from('documents').select('*')
      ]);
      const failed = results.find(result => result.error);
      if (failed) throw new Error(failed.error.message || 'Could not load purchase order data.');
      const [orderResult, itemResult, clientResult, supplierResult, documentResult] = results;
      const itemMap = (itemResult.data || []).reduce((map, item) => {
        (map[item.purchase_order_id] ||= []).push(item);
        return map;
      }, {});
      const documentMap = (documentResult.data || []).reduce((map, document) => {
        if (document.purchase_order_id !== undefined && document.purchase_order_id !== null) {
          (map[document.purchase_order_id] ||= []).push(document);
        }
        return map;
      }, {});
      setOrders(orderResult.data || []);
      setItemsByOrder(itemMap);
      setClients(clientResult.data || []);
      setSuppliers(supplierResult.data || []);
      setDocumentsByOrder(documentMap);
      setNotice(current => current?.kind === 'error' ? null : current);
    } catch (error) {
      setNotice({ kind: 'error', text: `Could not load purchase orders: ${error.message}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { Promise.resolve().then(refresh); }, []);

  const visibleOrders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return orders.filter(order => {
      const type = order.party_type || 'customer';
      const party = type === 'supplier'
        ? order.supplier_name || suppliers.find(row => localIdEquals(row.id, order.supplier_id))?.supplier_name
        : order.client_name || clients.find(row => localIdEquals(row.id, order.client_id))?.client_name;
      return (typeFilter === 'All' || typeFilter === type) &&
        (statusFilter === 'All' || order.status === statusFilter) &&
        (!query || [order.po_no, party, order.po_date, order.status].some(value =>
          String(value || '').toLowerCase().includes(query)
        ));
    });
  }, [orders, clients, suppliers, search, typeFilter, statusFilter]);

  const startCreate = () => {
    setEditingId(null);
    setForm(makeNewForm(orders.length));
    setNotice(null);
  };

  const startEdit = order => {
    const type = order.party_type || 'customer';
    const partyId = type === 'supplier' ? order.supplier_id : order.client_id;
    const party = (type === 'supplier' ? suppliers : clients).find(row => localIdEquals(row.id, partyId));
    const storedItems = itemsByOrder[order.id] || [];
    setEditingId(order.id);
    setForm({
      partyType: type,
      poNo: order.po_no || '',
      poDate: String(order.po_date || order.date || '').slice(0, 10),
      partyId: partyId ?? '',
      partyName: order.party_name || order.supplier_name || order.client_name || partyLabel(party, type),
      status: order.status || 'Received',
      items: storedItems.length ? storedItems.map(item => ({
        ...emptyItem(),
        ...item,
        quantity: String(item.quantity ?? 1),
        unit_price: String(item.unit_price ?? ''),
        tax_rate: String(item.tax_rate ?? '')
      })) : [emptyItem()],
      attachments: (documentsByOrder[order.id] || []).map(document => ({ existing: true, document }))
    });
    setNotice(null);
  };

  const updateForm = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const updateItem = (index, key, value) => setForm(current => ({
    ...current,
    items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item)
  }));
  const choosePartyType = partyType => setForm(current => ({
    ...current, partyType, partyId: '', partyName: ''
  }));
  const chooseClient = id => {
    const client = clients.find(row => localIdEquals(row.id, id));
    setForm(current => ({ ...current, partyId: id, partyName: client ? partyLabel(client, 'customer') : '' }));
  };
  const chooseSupplierName = name => {
    const supplier = suppliers.find(row => partyLabel(row, 'supplier').trim().toLowerCase() === name.trim().toLowerCase());
    setForm(current => ({ ...current, partyName: name, partyId: supplier?.id ?? '' }));
  };

  const addFiles = event => {
    const accepted = [];
    const rejected = [];
    Array.from(event.target.files || []).forEach(file => {
      if (file.type === 'application/pdf' || file.type.startsWith('image/')) accepted.push({ file });
      else rejected.push(file.name);
    });
    if (rejected.length) {
      setNotice({ kind: 'error', text: `Only PDF and image attachments are supported: ${rejected.join(', ')}` });
    } else {
      setNotice(null);
    }
    if (accepted.length) setForm(current => ({ ...current, attachments: [...current.attachments, ...accepted] }));
    event.target.value = '';
  };

  const downloadAttachment = async document => {
    const { data, error } = await localData.storage.from('documents').download(document.storage_path);
    if (error) {
      setNotice({ kind: 'error', text: `Could not open ${document.file_name || document.name}: ${error.message}` });
      return;
    }
    const url = URL.createObjectURL(data);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = document.file_name || document.name || 'purchase-order-attachment';
    link.click();
    URL.revokeObjectURL(url);
  };

  const uploadAttachments = async (purchaseOrderId, attachments) => {
    const pending = attachments.filter(entry => entry.file);
    if (!pending.length) return null;
    const bucket = localData.storage.from('documents');
    const uploaded = [];
    const metadata = [];
    for (const entry of pending) {
      const file = entry.file;
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const token = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const storagePath = `purchase-orders/${purchaseOrderId}/${token}-${safeName}`;
      const { error } = await bucket.upload(storagePath, file, { contentType: file.type });
      if (error) {
        if (uploaded.length) {
          const cleanup = await bucket.remove(uploaded);
          if (cleanup.error) {
            return `${error.message || 'Attachment upload failed.'} Cleanup failed: ${cleanup.error.message}`;
          }
        }
        return error.message || 'Attachment upload failed.';
      }
      uploaded.push(storagePath);
      metadata.push({
        purchase_order_id: purchaseOrderId,
        party_type: form.partyType,
        document_type: 'purchase_order_attachment',
        file_name: file.name,
        name: file.name,
        mime_type: file.type,
        size: file.size,
        storage_path: storagePath
      });
    }
    const result = await localData.atomic(database => {
      metadata.forEach(document => {
        document.id = nextId(database.documents);
        document.created_at = new Date().toISOString();
        document.updated_at = document.created_at;
        database.documents.push(document);
      });
    });
    if (result.error) {
      const cleanup = await bucket.remove(uploaded);
      return cleanup.error
        ? `${result.error.message} Local file cleanup also failed: ${cleanup.error.message}`
        : result.error.message;
    }
    return null;
  };

  const save = async event => {
    event.preventDefault();
    if (!form || saving) return;
    const partyName = form.partyType === 'customer'
      ? clients.find(row => localIdEquals(row.id, form.partyId))?.client_name
      : form.partyName.trim();
    if (!form.poNo.trim() || !form.poDate || !partyName) {
      setNotice({ kind: 'error', text: form.partyType === 'customer' ? 'Enter a PO number, date, and select a customer.' : 'Enter a PO number, date, and supplier name.' });
      return;
    }
    if (!form.items.length || form.items.some(item =>
      !item.description.trim() ||
      !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 ||
      !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0 ||
      !Number.isFinite(Number(item.tax_rate || 0)) || Number(item.tax_rate || 0) < 0 || Number(item.tax_rate || 0) > 100
    )) {
      setNotice({ kind: 'error', text: 'Add a description and valid quantity, unit price, and tax rate for every item.' });
      return;
    }
    setSaving(true);
    setNotice(null);
    const now = new Date().toISOString();
    const itemRows = form.items.map(item => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unit_price);
      const taxRate = Number(item.tax_rate || 0);
      const subtotal = quantity * unitPrice;
      return {
        description: item.description.trim(),
        quantity,
        dimensions: item.dimensions.trim(),
        specifications: item.specifications.trim(),
        unit_price: unitPrice,
        tax_rate: taxRate,
        subtotal,
        tax_amount: subtotal * taxRate / 100,
        total: subtotal * (1 + taxRate / 100)
      };
    });
    const result = await localData.atomic(database => {
      let supplier = null;
      if (form.partyType === 'supplier') {
        supplier = database.suppliers.find(row =>
          (form.partyId && localIdEquals(row.id, form.partyId)) ||
          partyLabel(row, 'supplier').trim().toLowerCase() === partyName.trim().toLowerCase()
        );
        if (!supplier) {
          supplier = {
            id: nextId(database.suppliers),
            supplier_name: partyName.trim(),
            created_at: now,
            updated_at: now
          };
          database.suppliers.push(supplier);
        }
      }
      const partyId = form.partyType === 'customer' ? form.partyId : supplier.id;
      const duplicate = database.purchase_orders.some(order =>
        order.id !== editingId &&
        (order.party_type || 'customer') === form.partyType &&
        String(form.partyType === 'customer' ? order.client_id : order.supplier_id) === String(partyId) &&
        String(order.po_no || '').trim().toLowerCase() === form.poNo.trim().toLowerCase()
      );
      if (duplicate) throw new Error('That purchase order number already exists for this party.');

      const order = {
        ...(database.purchase_orders.find(row => row.id === editingId) || {}),
        party_type: form.partyType,
        party_id: partyId,
        party_name: partyName.trim(),
        client_id: form.partyType === 'customer' ? partyId : null,
        supplier_id: form.partyType === 'supplier' ? partyId : null,
        client_name: form.partyType === 'customer' ? partyName.trim() : null,
        supplier_name: form.partyType === 'supplier' ? partyName.trim() : null,
        po_no: form.poNo.trim(),
        po_date: form.poDate,
        date: form.poDate,
        status: form.status,
        subtotal: itemRows.reduce((total, item) => total + item.subtotal, 0),
        tax_amount: itemRows.reduce((total, item) => total + item.tax_amount, 0),
        total: itemRows.reduce((total, item) => total + item.total, 0),
        updated_at: now
      };
      if (editingId === null) {
        order.id = nextId(database.purchase_orders);
        order.created_at = now;
        database.purchase_orders.push(order);
      } else {
        const orderIndex = database.purchase_orders.findIndex(row => row.id === editingId);
        if (orderIndex < 0) throw new Error('This purchase order no longer exists. Refresh and try again.');
        database.purchase_orders[orderIndex] = order;
        database.purchase_order_items = database.purchase_order_items.filter(item =>
          !localIdEquals(item.purchase_order_id, editingId)
        );
      }
      itemRows.forEach(item => {
        item.id = nextId(database.purchase_order_items);
        item.purchase_order_id = order.id;
        item.created_at = now;
        item.updated_at = now;
        database.purchase_order_items.push(item);
      });
      return order.id;
    });

    if (result.error) {
      setNotice({ kind: 'error', text: `Could not save purchase order: ${result.error.message}` });
      setSaving(false);
      return;
    }
    const savedId = result.data;
    if (editingId === null) setEditingId(savedId);
    const attachmentError = await uploadAttachments(savedId, form.attachments);
    await refresh();
    if (attachmentError) {
      setNotice({ kind: 'error', text: `Purchase order saved, but an attachment could not be saved: ${attachmentError}` });
      setSaving(false);
      return;
    }
    setNotice({ kind: 'success', text: `Purchase order ${editingId === null ? 'created' : 'updated'} successfully.` });
    setForm(null);
    setEditingId(null);
    setSaving(false);
  };

  const createInvoice = async order => {
    const type = order.party_type || 'customer';
    if (type !== 'customer' || !['Approved', 'Processing'].includes(order.status)) return;
    if (typeof onCreateInvoice !== 'function') {
      setNotice({ kind: 'error', text: 'Invoice creation is unavailable because no onCreateInvoice callback was provided.' });
      return;
    }
    const invoiceOrder = { ...order, items: itemsByOrder[order.id] || [] };
    try {
      await onCreateInvoice(invoiceOrder);
    } catch (error) {
      setNotice({ kind: 'error', text: `Could not start an invoice from this purchase order: ${error.message || 'Unknown error'}` });
    }
  };

  const deleteOrder = async order => {
    if (!window.confirm(`Delete purchase order ${order.po_no || ''} and its items?`)) return;
    const result = await localData.atomic(database => {
      database.purchase_orders = database.purchase_orders.filter(row => !localIdEquals(row.id, order.id));
      database.purchase_order_items = database.purchase_order_items.filter(row => !localIdEquals(row.purchase_order_id, order.id));
      database.documents = database.documents.filter(row =>
        !localIdEquals(row.purchase_order_id, order.id) || row.document_type !== 'purchase_order_attachment'
      );
    });
    if (result.error) {
      setNotice({ kind: 'error', text: `Could not delete purchase order: ${result.error.message}` });
      return;
    }
    const documents = (documentsByOrder[order.id] || []).filter(document =>
      document.document_type === 'purchase_order_attachment'
    );
    const paths = documents.map(document => document.storage_path).filter(Boolean);
    if (paths.length) {
      const { error } = await localData.storage.from('documents').remove(paths);
      if (error) setNotice({ kind: 'error', text: `Purchase order deleted, but local attachment cleanup failed: ${error.message}` });
      else setNotice({ kind: 'success', text: 'Purchase order deleted.' });
    } else setNotice({ kind: 'success', text: 'Purchase order deleted.' });
    await refresh();
  };

  const total = form ? itemTotals(form.items) : 0;
  return <>
    <style>{styles}</style>
    <div className="po-shell">
    <WorkspaceSidebar activeView="purchase-orders" onNavigate={onNavigate} workspaceMode={workspaceMode} />
    <main className="po-dashboard">
      <header className="po-head">
        <div><div className="po-eyebrow"><FileText size={14} /> ICANBILL / OPERATIONS</div><h1>Purchase orders</h1><p>Keep customer and supplier orders, line items, and attachments together on this device.</p></div>
        <button className="po-primary" onClick={startCreate}><Plus size={16} /> New purchase order</button>
      </header>
      {notice && <div className={`po-notice ${notice.kind}`} role="status">{notice.text}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={15} /></button></div>}
      <section className="po-card">
        <div className="po-toolbar">
          <label className="po-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search number or party" /></label>
          <select aria-label="Filter by party type" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option>All</option><option value="customer">Customers</option><option value="supplier">Suppliers</option></select>
          <select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option>All</option>{STATUSES.map(status => <option key={status}>{status}</option>)}</select>
        </div>
        {loading ? <div className="po-state"><LoaderCircle className="po-spin" size={22} /> Loading purchase orders…</div>
          : visibleOrders.length === 0 ? <div className="po-state"><FileText size={26} /><strong>{orders.length ? 'No matching purchase orders' : 'No purchase orders yet'}</strong><span>{orders.length ? 'Try another search or filter.' : 'Create a customer or supplier PO to start your history.'}</span>{!orders.length && <button className="po-secondary" onClick={startCreate}><Plus size={15} /> Create a purchase order</button>}</div>
            : <div className="po-table-wrap"><table className="po-table"><thead><tr><th>PO number</th><th>Party</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th><span className="po-sr-only">Actions</span></th></tr></thead><tbody>
              {visibleOrders.map(order => {
                const type = order.party_type || 'customer';
                const party = type === 'supplier'
                  ? order.supplier_name || suppliers.find(row => localIdEquals(row.id, order.supplier_id))?.supplier_name
                  : order.client_name || clients.find(row => localIdEquals(row.id, order.client_id))?.client_name;
                const items = itemsByOrder[order.id] || [];
                const attachments = documentsByOrder[order.id] || [];
                const eligible = type === 'customer' && !order.invoice_id && ['Approved', 'Processing'].includes(order.status);
                return <tr key={order.id}>
                  <td><strong>{order.po_no || '—'}</strong>{attachments.length > 0 && <span className="po-attachment-count">{attachments.length} attachment{attachments.length === 1 ? '' : 's'}</span>}</td>
                  <td><span className={`po-party-tag ${type}`}>{type === 'supplier' ? 'Supplier' : 'Customer'}</span><span className="po-party-name">{party || order.party_name || 'Unnamed party'}</span></td>
                  <td>{order.po_date || order.date || '—'}</td>
                  <td>{items.length}</td>
                  <td><strong>{money(order.total || 0)}</strong></td>
                  <td><span className={`po-status ${String(order.status || 'Received').toLowerCase()}`}>{order.status || 'Received'}</span></td>
                  <td><div className="po-row-actions">
                    {type === 'customer' && order.invoice_id && <span className="po-attachment-count">Invoice created</span>}
                    {eligible && <button className="po-invoice" type="button" onClick={() => createInvoice({ ...order, items })}><FilePlus2 size={14} /> Create invoice</button>}
                    {attachments.map(document => <button key={document.id} className="po-icon-button" type="button" title={`Download ${document.file_name || document.name}`} onClick={() => downloadAttachment(document)}><ArrowDownToLine size={15} /></button>)}
                    <button className="po-icon-button" type="button" title="Edit purchase order" onClick={() => startEdit(order)}><Pencil size={15} /></button>
                    <button className="po-icon-button danger" type="button" title="Delete purchase order" onClick={() => deleteOrder(order)}><Trash2 size={15} /></button>
                  </div></td>
                </tr>;
              })}
            </tbody></table></div>}
      </section>
    </main>
    </div>
    {form && <div className="po-modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !saving && setForm(null)}>
      <form className="po-modal" onSubmit={save}>
        <header className="po-modal-head"><div><span>{editingId === null ? 'NEW PURCHASE ORDER' : 'EDIT PURCHASE ORDER'}</span><h2>{editingId === null ? 'Record an order' : 'Update order'}</h2></div><button type="button" className="po-close" onClick={() => !saving && setForm(null)} aria-label="Close"><X size={19} /></button></header>
        <div className="po-form-scroll">
          <div className="po-form-row"><label>Party type<select value={form.partyType} onChange={event => choosePartyType(event.target.value)}><option value="customer">Customer PO</option><option value="supplier">Supplier PO</option></select></label><label>PO number<input required value={form.poNo} onChange={event => updateForm('poNo', event.target.value)} placeholder="e.g. PO-2026-001" /></label><label>PO date<input required type="date" value={form.poDate} onChange={event => updateForm('poDate', event.target.value)} /></label></div>
          {form.partyType === 'customer' ? <label className="po-field">Customer<select required value={form.partyId} onChange={event => chooseClient(event.target.value)}><option value="">Select a customer</option>{clients.map(client => <option key={client.id} value={client.id}>{partyLabel(client, 'customer')}</option>)}</select>{clients.length === 0 && <small>Add a customer record before creating a customer PO.</small>}</label>
            : <label className="po-field">Supplier name<input required list="po-suppliers" value={form.partyName} onChange={event => chooseSupplierName(event.target.value)} placeholder="Enter or select a supplier" /><datalist id="po-suppliers">{suppliers.map(supplier => <option key={supplier.id} value={partyLabel(supplier, 'supplier')} />)}</datalist><small>A new supplier is added to local records when you save this PO.</small></label>}
          <label className="po-field">Status<select value={form.status} onChange={event => updateForm('status', event.target.value)}>{STATUSES.map(status => <option key={status}>{status}</option>)}</select></label>
          <section className="po-items-section"><div className="po-section-head"><div><strong>Line items</strong><span>Description, dimensions, specifications, and tax</span></div><button type="button" className="po-secondary" onClick={() => setForm(current => ({ ...current, items: [...current.items, emptyItem()] }))}><Plus size={14} /> Add item</button></div>
            {form.items.map((item, index) => <div className="po-item" key={index}><div className="po-item-head"><strong>Item {index + 1}</strong>{form.items.length > 1 && <button type="button" className="po-remove-item" onClick={() => setForm(current => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 size={14} /> Remove</button>}</div>
              <label>Description<input required value={item.description} onChange={event => updateItem(index, 'description', event.target.value)} placeholder="Item or service" /></label>
              <div className="po-form-row"><label>Quantity<input required type="number" min="0.001" step="any" value={item.quantity} onChange={event => updateItem(index, 'quantity', event.target.value)} /></label><label>Dimensions<input value={item.dimensions} onChange={event => updateItem(index, 'dimensions', event.target.value)} placeholder="e.g. 2 × 3 m" /></label><label>Unit price<input required type="number" min="0" step="0.01" value={item.unit_price} onChange={event => updateItem(index, 'unit_price', event.target.value)} placeholder="0.00" /></label><label>Tax rate (%)<input type="number" min="0" max="100" step="0.01" value={item.tax_rate} onChange={event => updateItem(index, 'tax_rate', event.target.value)} placeholder="0" /></label></div>
              <label>Specifications<input value={item.specifications} onChange={event => updateItem(index, 'specifications', event.target.value)} placeholder="Material, finish, model, or other details" /></label>
            </div>)}
          </section>
          <section className="po-items-section"><div className="po-section-head"><div><strong>Documents</strong><span>Attach PDFs or images; files stay in this browser.</span></div><label className="po-secondary po-upload"><Upload size={14} /> Add files<input type="file" accept="application/pdf,image/*" multiple onChange={addFiles} /></label></div>
            {form.attachments.length ? <div className="po-file-list">{form.attachments.map((entry, index) => {
              const document = entry.document;
              const name = entry.file?.name || document.file_name || document.name;
              return <div className="po-file" key={entry.file ? `${name}-${index}` : document.id}>{entry.file?.type?.startsWith('image/') || document?.mime_type?.startsWith('image/') ? <Image size={16} /> : <FileText size={16} />}<span>{name}{entry.existing && <small>Saved locally</small>}</span>{entry.existing && <button type="button" className="po-icon-button" onClick={() => downloadAttachment(document)} title="Download attachment"><ArrowDownToLine size={14} /></button>}{!entry.existing && <button type="button" className="po-remove-item" onClick={() => setForm(current => ({ ...current, attachments: current.attachments.filter((_, fileIndex) => fileIndex !== index) }))} aria-label={`Remove ${name} from this form`}><X size={14} /></button>}</div>;
            })}</div> : <div className="po-file-empty">No attachments added.</div>}
          </section>
          <div className="po-total"><span>Estimated total (including tax)</span><strong>{money(total)}</strong></div>
        </div>
        <footer className="po-modal-actions"><button type="button" className="po-secondary" disabled={saving} onClick={() => setForm(null)}>Cancel</button><button type="submit" className="po-primary" disabled={saving}>{saving ? <><LoaderCircle className="po-spin" size={15} /> Saving…</> : <><FileText size={15} /> {editingId === null ? 'Save purchase order' : 'Save changes'}</>}</button></footer>
      </form>
    </div>}
  </>;
}

const styles = `
.po-shell{display:flex;min-height:calc(100vh - 68px);background:#f7f9fc}.po-dashboard{flex:1;min-width:0;max-width:1450px;margin:0 auto;padding:30px 34px 48px;color:#243347;font-family:Inter,system-ui,sans-serif}
.po-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:23px}.po-eyebrow{display:flex;align-items:center;gap:7px;color:#078478;font-size:10px;font-weight:800;letter-spacing:1.3px}.po-head h1{margin:8px 0 5px;color:#203043;font-size:27px;letter-spacing:-.7px}.po-head p{color:#7b8795;font-size:13px}
.po-primary,.po-secondary,.po-invoice,.po-icon-button,.po-close,.po-remove-item{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;cursor:pointer;font:inherit}.po-primary{min-height:40px;padding:0 15px;border-radius:9px;background:#087d73;color:#fff;font-size:12px;font-weight:700;box-shadow:0 5px 12px #087d7325}.po-primary:hover{background:#066a62}.po-primary:disabled{opacity:.65;cursor:wait}.po-secondary{min-height:32px;padding:0 10px;border:1px solid #dfe7ea;border-radius:8px;background:#fff;color:#405366;font-size:11px;font-weight:650}.po-secondary:hover{background:#f5faf9;border-color:#b7d9d4}.po-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;margin:0 0 15px;border:1px solid;border-radius:9px;font-size:12px}.po-notice.error{color:#a73535;background:#fff5f4;border-color:#f1ceca}.po-notice.success{color:#087d73;background:#effaf7;border-color:#cce9df}.po-notice button{border:0;background:transparent;color:inherit;cursor:pointer}.po-card{border:1px solid #e6eaed;border-radius:14px;background:#fff;box-shadow:0 7px 22px #25354a08;overflow:hidden}.po-toolbar{display:flex;align-items:center;gap:10px;padding:15px 17px;border-bottom:1px solid #edf0f2}.po-search{display:flex;align-items:center;gap:8px;flex:1;max-width:380px;padding:0 11px;border:1px solid #e5e9ec;border-radius:8px;color:#8995a2}.po-search input{width:100%;height:35px;border:0;outline:0;background:transparent;color:#25354a;font:inherit;font-size:12px}.po-toolbar select,.po-dashboard select{height:36px;padding:0 10px;border:1px solid #e1e7ea;border-radius:8px;background:#fff;color:#435368;font:inherit;font-size:12px;outline-color:#098478}.po-table-wrap{width:100%;overflow-x:auto}.po-table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}.po-table th{padding:12px 15px;background:#fafbfc;color:#8994a1;font-size:10px;font-weight:700;letter-spacing:.45px;text-transform:uppercase;white-space:nowrap}.po-table td{padding:14px 15px;border-top:1px solid #f0f2f4;color:#59697a;vertical-align:middle}.po-table tbody tr:hover{background:#fbfdfd}.po-table td>strong{color:#26364a}.po-party-tag,.po-status{display:inline-flex;padding:4px 7px;border-radius:20px;font-size:9px;font-weight:750;white-space:nowrap}.po-party-tag{margin-right:7px;background:#eaf4fb;color:#387ca2}.po-party-tag.supplier{background:#f1ecfb;color:#7656a0}.po-party-name{color:#39495e}.po-status{background:#f1f3f5;color:#687484}.po-status.received{background:#edf4fb;color:#39759e}.po-status.processing{background:#fff5df;color:#a37517}.po-status.approved{background:#e8f7f1;color:#148060}.po-status.completed{background:#eaf4f5;color:#23717a}.po-status.cancelled{background:#fff0ef;color:#b24a45}.po-attachment-count{display:block;margin-top:4px;color:#8794a2;font-size:10px}.po-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-width:140px}.po-icon-button{width:29px;height:29px;border:1px solid transparent;border-radius:7px;background:transparent;color:#718091}.po-icon-button:hover{border-color:#e5e9eb;background:#f8fafb}.po-icon-button.danger:hover{border-color:#f2d8d5;background:#fff5f4;color:#b5443d}.po-invoice{padding:6px 8px;border:1px solid #cfe7de;border-radius:7px;background:#f0faf6;color:#087d66;font-size:10px;font-weight:700;white-space:nowrap}.po-invoice:hover{background:#e2f5ee}.po-state{min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;color:#91a0ad;font-size:12px}.po-state strong{color:#536477;font-size:14px}.po-state .po-secondary{margin-top:5px}.po-spin{animation:po-spin .9s linear infinite}@keyframes po-spin{to{transform:rotate(360deg)}}.po-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.po-modal-backdrop{position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;padding:20px;background:#17233380;backdrop-filter:blur(3px)}.po-modal{display:flex;flex-direction:column;width:min(820px,100%);max-height:min(92vh,950px);border:1px solid #e4e9ec;border-radius:15px;background:#fff;box-shadow:0 22px 65px #13203340;overflow:hidden}.po-modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #edf0f2}.po-modal-head>div>span{color:#0a8277;font-size:9px;font-weight:800;letter-spacing:1px}.po-modal-head h2{margin-top:4px;color:#27374b;font-size:19px}.po-close{width:32px;height:32px;border-radius:8px;background:#f5f7f8;color:#718091}.po-form-scroll{padding:19px 22px;overflow-y:auto}.po-modal label{display:flex;flex-direction:column;gap:6px;color:#526174;font-size:11px;font-weight:650}.po-modal label input,.po-modal label select{width:100%;min-width:0;height:37px;padding:0 10px;border:1px solid #e0e6e9;border-radius:7px;background:#fff;color:#2c3d50;font:inherit;font-size:12px;outline-color:#0a8277}.po-modal label small{color:#8b96a2;font-size:10px;font-weight:400}.po-field{margin-top:14px}.po-form-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px}.po-items-section{margin-top:20px;padding-top:16px;border-top:1px solid #edf0f2}.po-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.po-section-head>div{display:grid;gap:3px}.po-section-head strong{color:#34465b;font-size:13px}.po-section-head span{color:#8a96a2;font-size:10px}.po-item{display:grid;gap:11px;margin-bottom:10px;padding:13px;border:1px solid #e8edef;border-radius:9px;background:#fbfcfc}.po-item-head{display:flex;justify-content:space-between;align-items:center;color:#45566a;font-size:11px}.po-item .po-form-row{grid-template-columns:.7fr 1.2fr 1fr .8fr}.po-remove-item{padding:3px;border:0;background:transparent;color:#84909c;font-size:10px}.po-remove-item:hover{color:#bb4c43}.po-upload{position:relative;overflow:hidden;cursor:pointer}.po-upload input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.po-file-list{display:grid;gap:6px}.po-file{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid #e8edef;border-radius:7px;color:#728092;font-size:11px}.po-file>span{display:grid;flex:1;gap:2px;overflow:hidden;color:#3f5064;text-overflow:ellipsis}.po-file>span small{color:#8e9aa5;font-size:9px}.po-file-empty{padding:10px;border:1px dashed #e2e8eb;border-radius:8px;color:#98a3ad;font-size:10px}.po-total{display:flex;align-items:center;justify-content:space-between;margin-top:19px;padding:14px 15px;border-radius:9px;background:#f1f8f6;color:#5a6c76;font-size:11px}.po-total strong{color:#08786e;font-size:16px}.po-modal-actions{display:flex;justify-content:flex-end;gap:9px;padding:14px 22px;border-top:1px solid #edf0f2;background:#fcfdfd}
@media(max-width:760px){.po-dashboard{padding:22px 15px 35px}.po-head{align-items:flex-start;flex-direction:column}.po-head .po-primary{align-self:stretch}.po-head h1{font-size:23px}.po-toolbar{flex-wrap:wrap}.po-search{flex-basis:100%;max-width:none}.po-toolbar select{flex:1;min-width:120px}.po-table{min-width:760px}.po-form-row{grid-template-columns:1fr 1fr}.po-item .po-form-row{grid-template-columns:1fr 1fr}.po-modal-backdrop{padding:8px}.po-modal{max-height:96vh}.po-form-scroll{padding:15px}.po-modal-head,.po-modal-actions{padding-left:15px;padding-right:15px}}
@media(max-width:420px){.po-form-row,.po-item .po-form-row{grid-template-columns:1fr 1fr}.po-section-head{align-items:flex-start;flex-direction:column}}
`;
