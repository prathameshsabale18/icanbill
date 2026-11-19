import React, { useEffect, useMemo, useState } from 'react';
import { Check, Plus, WalletCards } from 'lucide-react';
import { localData } from '../localDataClient';
import { calculateInvoiceReportTotals } from '../utils/invoiceReportPdf';
import WorkspaceSidebar from './WorkspaceSidebar';

const METHODS = ['Cash', 'UPI', 'Card', 'Bank transfer', 'Other'];
const money = value => `Rs. ${Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;
const nextId = rows => rows.reduce((maximum, row) =>
  Number.isFinite(Number(row.id)) ? Math.max(maximum, Number(row.id)) : maximum
, 0) + 1;
const getInvoiceTotal = invoice => {
  const storedTotal = Number(invoice.grand_total ?? invoice.amount);
  return Number.isFinite(storedTotal) && storedTotal >= 0
    ? storedTotal
    : calculateInvoiceReportTotals(invoice).grandTotal;
};
const getAmountPaid = (invoice, total) => {
  const storedAmount = Number(invoice.amount_paid);
  if (Number.isFinite(storedAmount) && invoice.amount_paid !== null && invoice.amount_paid !== undefined) {
    return Math.min(total, Math.max(0, storedAmount));
  }
  return ['paid', 'successful'].includes(String(invoice.status || '').toLowerCase())
    ? total
    : 0;
};

export default function PaymentsDashboard({ onNavigate, workspaceMode }) {
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [paymentForm, setPaymentForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [invoiceResult, paymentResult] = await Promise.all([
        localData.from('invoices').select('*').order('id', { ascending: false }),
        localData.from('payments').select('*').order('paid_at', { ascending: false }),
      ]);
      if (invoiceResult.error) throw new Error(invoiceResult.error.message);
      if (paymentResult.error) throw new Error(paymentResult.error.message);
      setInvoices(invoiceResult.data || []);
      setPayments(paymentResult.data || []);
    } catch (error) {
      setNotice(`Could not load payments: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const invoiceById = useMemo(
    () => new Map(invoices.map(invoice => [String(invoice.id), invoice])),
    [invoices]
  );
  const outstandingInvoices = useMemo(() => invoices.map(invoice => {
    const total = getInvoiceTotal(invoice);
    const paid = getAmountPaid(invoice, total);
    return { ...invoice, total, paid, due: Math.max(0, total - paid) };
  }).filter(invoice => invoice.due > 0), [invoices]);
  const totals = useMemo(() => ({
    collected: payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0),
    outstanding: outstandingInvoices.reduce((sum, invoice) => sum + invoice.due, 0),
  }), [payments, outstandingInvoices]);

  const startPayment = invoice => setPaymentForm({
    invoiceId: invoice.id,
    amount: String(invoice.due),
    method: 'Cash',
    reference: '',
    date: new Date().toISOString().slice(0, 10),
  });

  const recordPayment = async event => {
    event.preventDefault();
    if (!paymentForm || saving) return;
    const amount = Number(paymentForm.amount);
    const invoice = invoiceById.get(String(paymentForm.invoiceId));
    const due = invoice
      ? Math.max(0, getInvoiceTotal(invoice) - getAmountPaid(invoice, getInvoiceTotal(invoice)))
      : 0;
    if (!invoice || !Number.isFinite(amount) || amount <= 0 || amount > due) {
      setNotice('Enter a payment greater than zero and no more than the current balance.');
      return;
    }
    if (!paymentForm.method || !paymentForm.date) {
      setNotice('Select a payment method and date.');
      return;
    }

    setSaving(true);
    setNotice('');
    const now = new Date().toISOString();
    const result = await localData.atomic(database => {
      const current = database.invoices.find(row =>
        String(row.id) === String(paymentForm.invoiceId)
      );
      if (!current) throw new Error('This invoice no longer exists.');
      const invoiceTotal = getInvoiceTotal(current);
      const currentPaid = getAmountPaid(current, invoiceTotal);
      const remaining = Math.max(0, invoiceTotal - currentPaid);
      if (amount > remaining) {
        throw new Error('The invoice balance changed. Refresh and enter an updated payment amount.');
      }
      const nextPaid = currentPaid + amount;
      current.amount_paid = nextPaid;
      current.status = nextPaid >= invoiceTotal ? 'Paid' : 'Partially Paid';
      current.payment_method = paymentForm.method;
      current.updated_at = now;
      database.payments.push({
        id: nextId(database.payments),
        invoice_id: current.id,
        amount,
        method: paymentForm.method,
        reference: paymentForm.reference.trim(),
        paid_at: new Date(`${paymentForm.date}T12:00:00`).toISOString(),
        created_at: now,
        updated_at: now,
      });
      return current.id;
    });

    if (result.error) {
      setNotice(`Could not record payment: ${result.error.message}`);
      setSaving(false);
      return;
    }
    setPaymentForm(null);
    await refresh();
    setNotice('Payment recorded.');
    setSaving(false);
  };

  const paymentHistory = useMemo(() => payments.map(payment => ({
    ...payment,
    invoice: invoiceById.get(String(payment.invoice_id)),
  })).sort((left, right) => String(right.paid_at || '').localeCompare(String(left.paid_at || ''))), [payments, invoiceById]);

  return (
    <>
      <div className="payments-shell">
        <WorkspaceSidebar activeView="payments" onNavigate={onNavigate} workspaceMode={workspaceMode} />
        <main className="payments-main">
          <header className="payments-header">
            <div><span>ICANBILL / COLLECTIONS</span><h1>Payments</h1><p>Record incoming payments and track each invoice balance.</p></div>
            <button type="button" className="payments-refresh" onClick={refresh}>Refresh</button>
          </header>
          {notice && <div className="payments-notice" role="status">{notice}</div>}
          <section className="payments-metrics">
            <article><span>Total recorded</span><strong>{money(totals.collected)}</strong><small>All payment entries</small></article>
            <article><span>Outstanding balance</span><strong>{money(totals.outstanding)}</strong><small>{outstandingInvoices.length} unpaid or partially paid invoices</small></article>
          </section>
          <section className="payments-card">
            <h2>Invoices needing payment</h2>
            {loading ? <p className="payments-empty">Loading invoices…</p> : outstandingInvoices.length === 0
              ? <p className="payments-empty">All recorded invoices are fully paid.</p>
              : <div className="payments-table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Paid</th><th>Balance</th><th /></tr></thead><tbody>
                {outstandingInvoices.map(invoice => <tr key={invoice.id}>
                  <td>{invoice.invoice_no || `#${invoice.id}`}</td>
                  <td>{invoice.client_name || 'Unnamed customer'}</td>
                  <td>{money(invoice.total)}</td>
                  <td>{money(invoice.paid)}</td>
                  <td><strong>{money(invoice.due)}</strong></td>
                  <td><button type="button" className="payments-primary" onClick={() => startPayment(invoice)}><Plus size={14} /> Record payment</button></td>
                </tr>)}
              </tbody></table></div>}
          </section>
          <section className="payments-card">
            <h2><WalletCards size={18} /> Payment history</h2>
            {paymentHistory.length === 0 ? <p className="payments-empty">Payments recorded from invoices will appear here.</p>
              : <div className="payments-table-wrap"><table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>
                {paymentHistory.map(payment => <tr key={payment.id}>
                  <td>{payment.paid_at ? new Date(payment.paid_at).toLocaleDateString() : '—'}</td>
                  <td>{payment.invoice?.invoice_no || `#${payment.invoice_id}`}</td>
                  <td>{payment.invoice?.client_name || 'Unnamed customer'}</td>
                  <td>{payment.method || '—'}</td>
                  <td>{payment.reference || '—'}</td>
                  <td><strong>{money(payment.amount)}</strong></td>
                </tr>)}
              </tbody></table></div>}
          </section>
        </main>
      </div>
      {paymentForm && <div className="payments-backdrop" onMouseDown={event => event.target === event.currentTarget && !saving && setPaymentForm(null)}>
        <form className="payments-modal" onSubmit={recordPayment}>
          <header><div><span>PAYMENT ENTRY</span><h2>Record payment</h2><small>{invoiceById.get(String(paymentForm.invoiceId))?.invoice_no || 'Invoice'}</small></div><button type="button" onClick={() => setPaymentForm(null)} aria-label="Close">×</button></header>
          <label>Amount<input required type="number" min="0.01" step="0.01" max={invoiceById.get(String(paymentForm.invoiceId))?.due || undefined} value={paymentForm.amount} onChange={event => setPaymentForm(current => ({ ...current, amount: event.target.value }))} /></label>
          <label>Payment method<select value={paymentForm.method} onChange={event => setPaymentForm(current => ({ ...current, method: event.target.value }))}>{METHODS.map(method => <option key={method}>{method}</option>)}</select></label>
          <label>Reference (optional)<input value={paymentForm.reference} onChange={event => setPaymentForm(current => ({ ...current, reference: event.target.value }))} placeholder="Transaction or cheque number" /></label>
          <label>Payment date<input required type="date" value={paymentForm.date} onChange={event => setPaymentForm(current => ({ ...current, date: event.target.value }))} /></label>
          <footer><button type="button" className="payments-refresh" disabled={saving} onClick={() => setPaymentForm(null)}>Cancel</button><button className="payments-primary" disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save payment'}</button></footer>
        </form>
      </div>}
      <style>{styles}</style>
    </>
  );
}

const styles = `
.payments-shell{display:flex;min-height:calc(100vh - 68px);background:#f7f9fc;color:#243347}.payments-main{flex:1;min-width:0;padding:32px 36px 48px}.payments-header{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:22px}.payments-header span,.payments-modal header span{color:#087d73;font-size:10px;font-weight:800;letter-spacing:1px}.payments-header h1{margin:7px 0;color:#203043;font-size:27px}.payments-header p{margin:0;color:#7b8795;font-size:13px}.payments-refresh,.payments-primary{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid #dfe7ea;border-radius:8px;background:#fff;color:#405366;font-size:11px;font-weight:700;cursor:pointer}.payments-primary{border-color:#087d73;background:#087d73;color:#fff}.payments-primary:disabled{opacity:.6;cursor:wait}.payments-notice{margin-bottom:14px;padding:11px 13px;border-radius:8px;background:#effaf7;color:#087d73;font-size:12px}.payments-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:16px}.payments-metrics article,.payments-card{padding:18px;border:1px solid #e6eaed;border-radius:12px;background:#fff;box-shadow:0 7px 22px #25354a08}.payments-metrics article span,.payments-metrics article small{display:block;color:#8390a0;font-size:11px}.payments-metrics article strong{display:block;margin:7px 0;color:#203043;font-size:23px}.payments-card{margin-top:14px}.payments-card h2{display:flex;align-items:center;gap:8px;margin:0 0 14px;color:#314357;font-size:15px}.payments-card h2 svg{color:#087d73}.payments-empty{padding:25px 10px;color:#8794a2;text-align:center;font-size:12px}.payments-table-wrap{overflow-x:auto}.payments-card table{width:100%;border-collapse:collapse;text-align:left;font-size:11px}.payments-card th{padding:10px;color:#8994a1;font-size:9px;text-transform:uppercase;white-space:nowrap}.payments-card td{padding:11px 10px;border-top:1px solid #f0f2f4;color:#566578;white-space:nowrap}.payments-card td strong{color:#26364a}.payments-backdrop{position:fixed;inset:0;z-index:600;display:grid;place-items:center;padding:18px;background:#17233380}.payments-modal{width:min(460px,100%);padding:21px;border-radius:14px;background:#fff;box-shadow:0 22px 65px #13203340}.payments-modal header{display:flex;justify-content:space-between;margin-bottom:17px}.payments-modal header h2{margin:5px 0;color:#26364a;font-size:19px}.payments-modal header small{color:#8390a0;font-size:11px}.payments-modal header button{width:30px;height:30px;border:0;border-radius:7px;background:#f2f5f6;color:#677587;font-size:20px;cursor:pointer}.payments-modal label{display:grid;gap:6px;margin-top:12px;color:#566578;font-size:11px;font-weight:700}.payments-modal input,.payments-modal select{height:38px;padding:0 10px;border:1px solid #dfe6e9;border-radius:7px;background:#fff;color:#29394d;font:inherit;font-weight:400}.payments-modal footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}@media(max-width:750px){.payments-main{padding:23px 15px 35px}.payments-header{align-items:flex-start;flex-direction:column}.payments-metrics{grid-template-columns:1fr}.payments-table{min-width:700px}}
`;
