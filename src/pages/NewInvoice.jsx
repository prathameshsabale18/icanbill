import React, { useState } from 'react';
import InvoiceForm from '../components/InvoiceForm';
import { saveInvoiceLocally } from '../utils/saveInvoice';
import { getTodayInvoiceDate } from '../utils/invoiceDates';
import { useNavigate } from 'react-router-dom';

export default function NewInvoice() {
  const navigate = useNavigate();
  const [invoiceData, setInvoiceData] = useState({
    invoiceNo: '',
    invoiceDate: getTodayInvoiceDate(),
    poNo: '',
    poDate: '',
    freight: 0,
    clientName: '',
    clientAddress: '',
    clientGstin: '',
    clientState: '',
    clientStateCode: '',
    clientVendorCode: '',
    status: 'Pending',
    docType: 'TAX_INVOICE',
    gstRate: 18
  });

  const [items, setItems] = useState([
    { description: '', hsn: '', quantity: 1, rate: 0, baseRate: 0, per: 'Nos' }
  ]);

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const isChallan = invoiceData.docType === 'DC_CHALLAN';
    const stateCode = String(invoiceData.clientStateCode || '').trim();

    if (!isChallan && !/^\d{2}$/.test(stateCode)) {
      alert('Enter the customer place-of-supply state code (two digits) before saving the tax invoice.');
      return;
    }

    setSaving(true);
    try {
      const result = await saveInvoiceLocally(
        { ...invoiceData, gstRate: isChallan ? 0 : 18 },
        items
      );

      if (result.success) {
        alert(`${invoiceData.docType === 'DC_CHALLAN' ? 'Delivery Challan' : 'Invoice'} #${result.invoiceNo} saved successfully!`);
        navigate('/dashboard');
      }
    } catch (err) {
      console.error('Failed to save document:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>{invoiceData.docType === 'DC_CHALLAN' ? 'Create Delivery Challan' : 'Create Invoice'}</h2>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* 4. Document Type Dropdown Selector */}
          <select
            value={invoiceData.docType}
            onChange={(e) => setInvoiceData({ ...invoiceData, docType: e.target.value })}
            style={{ padding: '10px 14px', borderRadius: '6px', border: '1px solid #ccc', fontWeight: 600 }}
          >
            <option value="TAX_INVOICE">Tax Invoice</option>
            <option value="DC_CHALLAN">DC Challan</option>
          </select>

          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
            style={{ background: 'var(--cc-teal)', color: '#fff', padding: '10px 20px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontWeight: 600 }}
          >
            {saving ? 'Saving...' : 'Save & Submit'}
          </button>
        </div>
      </div>

      <InvoiceForm
        showGstBreakdown
        invoiceData={invoiceData}
        setInvoiceData={setInvoiceData}
        items={items}
        setItems={setItems}
      />
    </div>
  );
}
