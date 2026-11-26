import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import InvoiceForm from './components/InvoiceForm';
import Dashboard from './components/Dashboard';
import OverviewDashboard from './components/OverviewDashboard';
import ClientsDashboard from './components/ClientsDashboard';
import WorkspaceSidebar from './components/WorkspaceSidebar';
import WorkspaceSettings from './components/WorkspaceSettings';
import RetailBilling from './components/RetailBilling';
import PurchaseOrdersDashboard from './components/PurchaseOrdersDashboard';
import PaymentsDashboard from './components/PaymentsDashboard';
import QuotationsDashboard from './components/QuotationsDashboard';
import OrganizerDashboard from './components/OrganizerDashboard';
import { calculateTotals } from './utils/calculations';
import { stampInvoice } from './utils/pdfStamper';
import { numberToWords } from './utils/calculations';
import { saveInvoiceLocally } from './utils/saveInvoice';
import { convertPdfToJpeg } from './utils/invoiceImage';
import { saveInvoicePdf } from './utils/invoicePdfStorage';
import { getTodayInvoiceDate } from './utils/invoiceDates';
import { localData } from './localDataClient';
import download from 'downloadjs';
import AuthGate from './components/AuthGate';
import { supabase } from './supabaseClient';
import {
  Download,
  FileText,
  Eye,
  Loader2,
  X,
  AlertCircle,
  Save
} from 'lucide-react';

const today = getTodayInvoiceDate();
const INVOICE_SERIES_PREFIX = 'INV-';

const generateNextInvoiceNumber = async () => {
  try {
    const { data, error } = await localData
      .from('invoices')
      .select('invoice_no');

    if (error) throw error;

    let maxNo = 0;

    if (data && data.length > 0) {
      data.forEach(row => {
        const match = String(row.invoice_no || '').match(/^INV-(\d+)$/i);
        const num = match ? Number(match[1]) : 0;

        if (!Number.isNaN(num) && num > maxNo) {
          maxNo = num;
        }
      });
    }

    return `${INVOICE_SERIES_PREFIX}${String(maxNo + 1).padStart(4, '0')}`;
  } catch (err) {
    console.error('Failed to fetch the local invoice sequence:', err);
    throw err;
  }
};

function InvoiceWorkspace() {
  const [workspaceMode, setWorkspaceMode] = useState(() => (
    localStorage.getItem('workspace_mode') === 'retail' ? 'retail' : 'business'
  ));
  const [workspaceSetupRequired, setWorkspaceSetupRequired] = useState(
    () => !['retail', 'business'].includes(localStorage.getItem('workspace_mode'))
  );
  const [activeTab, setActiveTab] = useState(() => {
    const savedTab = localStorage.getItem('billing_mvp_active_tab');
    const restoredTab = savedTab === 'dashboard' ? 'overview' : savedTab || 'overview';
    const availableTabs = ['overview', 'user', 'clients', 'billing', 'payments', 'organizer', 'generator', 'settings', 'retail', 'purchase-orders', 'quotations'];
    if (!availableTabs.includes(restoredTab)) return 'overview';
    if (workspaceMode === 'business' && restoredTab === 'retail') return 'overview';
    if (workspaceMode === 'retail' && restoredTab === 'purchase-orders') return 'overview';
    if (workspaceMode === 'retail' && restoredTab === 'quotations') return 'overview';
    return restoredTab;
  });

  const isChallan = false;
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const [copyType, setCopyType] = useState('Master Copy');

  const [copyFormats, setCopyFormats] = useState({
    'Master Copy': 'pdf',
    'Office Copy': 'pdf',
    'DCCHALLAN': 'pdf',
  });

  const [savedInvoiceNo, setSavedInvoiceNo] = useState(null);
  const [savedInvoiceId, setSavedInvoiceId] = useState(null);
  const [error, setError] = useState(null);

  const prevUrlRef = useRef(null);
  const previewRequestRef = useRef(0);

  const navigateToTab = (tab) => {
    setActiveTab(tab);
    localStorage.setItem('billing_mvp_active_tab', tab);
  };

  const changeWorkspaceMode = mode => {
    if (!['retail', 'business'].includes(mode)) {
      throw new Error(`Unknown workspace mode: ${mode}`);
    }
    localStorage.setItem('workspace_mode', mode);
    setWorkspaceMode(mode);
    setWorkspaceSetupRequired(false);
    if (
      (mode === 'business' && activeTab === 'retail') ||
      (mode === 'retail' && ['purchase-orders', 'quotations'].includes(activeTab))
    ) {
      navigateToTab('overview');
    }
  };

  const handleCreateInvoiceFromPurchaseOrder = async purchaseOrder => {
    if (!purchaseOrder || purchaseOrder.party_type === 'supplier') {
      throw new Error('Only customer purchase orders can be converted to invoices.');
    }
    if (purchaseOrder.invoice_id) {
      throw new Error('An invoice has already been created for this purchase order.');
    }
    const clientQuery = localData.from('clients').select('*');
    const clientResult = purchaseOrder.client_id
      ? await clientQuery.eq('id', purchaseOrder.client_id).maybeSingle()
      : await clientQuery.eq('client_name', purchaseOrder.client_name).maybeSingle();
    if (clientResult.error) throw new Error(clientResult.error.message);
    const client = clientResult.data;
    const invoiceItems = (purchaseOrder.items || []).map(item => {
      const details = [item.dimensions, item.specifications].filter(Boolean).join(' — ');
      return {
        description: [item.description, details].filter(Boolean).join('\n'),
        hsn: '',
        quantity: Number(item.quantity) || 1,
        rate: Number(item.unit_price) || 0,
        baseRate: Number(item.unit_price) || 0,
        per: 'Nos',
      };
    });
    if (!invoiceItems.length) {
      throw new Error('This purchase order has no items to invoice.');
    }
    setInvoiceData(prev => ({
      ...prev,
      clientId: client?.id ?? purchaseOrder.client_id ?? null,
      clientName: client?.client_name || purchaseOrder.client_name || purchaseOrder.party_name || '',
      clientAddress: client?.address || '',
      clientGstin: client?.gst_no || '',
      clientEmail: client?.email || '',
      poNo: purchaseOrder.po_no || '',
      poDate: purchaseOrder.po_date || purchaseOrder.date || '',
      purchaseOrderId: purchaseOrder.id,
    }));
    setItems(invoiceItems);
    setError(null);
    navigateToTab('generator');
  };

  const handleCreateInvoiceFromQuotation = async quotation => {
    if (!quotation || quotation.invoice_id || quotation.status !== 'Approved') {
      throw new Error('Only approved quotations without an existing invoice can be converted.');
    }
    const clientResult = await localData
      .from('clients')
      .select('*')
      .eq('id', quotation.client_id)
      .maybeSingle();
    if (clientResult.error) throw new Error(clientResult.error.message);
    const client = clientResult.data;
    const invoiceItems = (quotation.items || []).map(item => {
      const details = [item.dimensions, item.specifications].filter(Boolean).join(' — ');
      return {
        description: [item.description, details].filter(Boolean).join('\n'),
        hsn: '',
        quantity: Number(item.quantity) || 1,
        rate: Number(item.unit_price) || 0,
        baseRate: Number(item.unit_price) || 0,
        per: 'Nos',
      };
    });
    if (!invoiceItems.length) throw new Error('This quotation has no items to invoice.');
    setInvoiceData(prev => ({
      ...prev,
      clientId: client?.id ?? quotation.client_id ?? null,
      clientName: client?.client_name || quotation.client_name || '',
      clientAddress: client?.address || '',
      clientGstin: client?.gst_no || '',
      clientEmail: client?.email || '',
      poNo: '',
      poDate: '',
      quotationId: quotation.id,
    }));
    setItems(invoiceItems);
    setError(null);
    navigateToTab('generator');
  };

  const handleRetailCheckout = async ({ invoiceData: saleData, items: saleItems }) => {
    const stockChanges = saleItems.map(item => ({
      productId: item.productId,
      quantity: Number(item.quantity || 0),
    }));
    const savedInvoice = await saveInvoiceLocally(saleData, saleItems, {
      stockChanges,
    });
    if (!savedInvoice?.success || !savedInvoice.invoiceId) {
      return {
        success: false,
        error: savedInvoice?.error || 'Could not save the retail invoice.',
      };
    }

    try {
      const totals = {
        ...calculateTotals(saleItems, saleData.clientGstin, saleData.freight),
      };
      totals.inWords = numberToWords(totals.grandTotal || 0);
      const pdfBlob = await stampInvoice(
        { ...saleData, invoiceNo: savedInvoice.invoiceNo },
        totals,
        'invoice',
        'master',
        'full'
      );
      await saveInvoicePdf(savedInvoice.invoiceId, pdfBlob);
      return { success: true, invoiceNo: savedInvoice.invoiceNo };
    } catch (pdfError) {
      console.error('Retail sale was saved, but its PDF could not be generated:', pdfError);
      return {
        success: true,
        invoiceNo: savedInvoice.invoiceNo,
        warning: `Sale ${savedInvoice.invoiceNo} was saved and stock deducted, but its PDF could not be saved: ${pdfError.message}`,
      };
    }
  };

  const [invoiceData, setInvoiceData] = useState({
    invoiceNo: 'INV-0001',
    invoiceDate: today,
    poNo: '',
    poDate: '',
    freight: 0,
    clientName: '',
    clientAddress: '',
    clientGstin: '',
    clientState: '',
    clientStateCode: '',
    clientVendorCode: '',
    clientEmail: '',
    status: 'Pending',
  });

  const [items, setItems] = useState([]);

  useEffect(() => {
    async function fetchLatestInvoiceNo() {
      if (activeTab === 'generator') {
        setSavedInvoiceNo(null);
        setSavedInvoiceId(null);

        try {
          const nextInvoiceNo = await generateNextInvoiceNumber();

          setInvoiceData(prev => ({
            ...prev,
            invoiceNo: nextInvoiceNo
          }));
        } catch (sequenceError) {
          setError(sequenceError.message);
        }
      }
    }

    fetchLatestInvoiceNo();
  }, [activeTab]);

  const totals = useMemo(
    () =>
      calculateTotals(
        items,
        invoiceData.clientGstin,
        invoiceData.freight
      ),
    [
      items,
      invoiceData.clientGstin,
      invoiceData.freight
    ]
  );

  const enrichedTotals = useMemo(
    () => ({
      ...totals,
      inWords: numberToWords(totals.grandTotal || 0),
    }),
    [totals]
  );

  const getTemplateKey = useCallback(
    () => (
      copyType === 'Office Copy'
        ? 'office'
        : copyType === 'DCCHALLAN'
          ? 'dcchallan'
          : 'master'
    ),
    [copyType]
  );

  const selectedFormat = copyFormats[copyType];

  const setSelectedFormat = (format) => {
    setCopyFormats(prev => ({
      ...prev,
      [copyType]: format
    }));
  };

  // Master Copy JPG uses the print-ready template without the company header.
  // PDF output and other copy types use their standard templates.
  const generateOutput = useCallback(async () => {
    const templateKey = getTemplateKey();

    const pdfBlob = await stampInvoice(
      invoiceData,
      enrichedTotals,
      isChallan ? 'challan' : 'invoice',
      templateKey,
      selectedFormat === 'jpg' && templateKey === 'master'
        ? 'print'
        : 'full'
    );

    return selectedFormat === 'jpg'
      ? convertPdfToJpeg(pdfBlob)
      : pdfBlob;
  }, [
    invoiceData,
    enrichedTotals,
    isChallan,
    getTemplateKey,
    selectedFormat
  ]);

  const handlePreview = async () => {
    const requestId = ++previewRequestRef.current;
    setIsGenerating(true);
    setError(null);
    setPreviewError('');
    setPreviewUrl(null);
    setShowModal(true);

    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current);
      prevUrlRef.current = null;
    }

    try {
      const blob = await generateOutput();

      if (requestId !== previewRequestRef.current) return;

      const url = URL.createObjectURL(blob);

      prevUrlRef.current = url;

      setPreviewUrl(url);

    } catch (err) {
      if (requestId !== previewRequestRef.current) return;

      const message = err?.message || 'Could not generate the invoice preview.';
      setError(message);
      setPreviewError(message);

    } finally {
      if (requestId === previewRequestRef.current) {
        setIsGenerating(false);
      }
    }
  };

  const closeModal = () => {
    previewRequestRef.current += 1;
    setIsGenerating(false);
    setShowModal(false);
    setPreviewUrl(null);
    setPreviewError('');
    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current);
      prevUrlRef.current = null;
    }
  };

  // ---------------------------------------------------------
  // SAVE INVOICE
  // Saves a local record and its canonical PDF.
  // Does NOT download anything.
  // ---------------------------------------------------------
  const handleSave = async () => {
    setIsDownloading(true);
    setError(null);

    try {
      // Prevent saving the same invoice again.
      if (savedInvoiceId) {
        return;
      }

      const saveResult = await saveInvoiceLocally(
        invoiceData,
        items
      );

      if (!saveResult?.success) {
        throw new Error(saveResult?.error || 'Local save failed.');
      }

      const confirmedInvoiceNo = saveResult.invoiceNo;
      const confirmedInvoiceId = saveResult.invoiceId;

      setSavedInvoiceId(confirmedInvoiceId);
      setSavedInvoiceNo(confirmedInvoiceNo);

      setInvoiceData(prev => ({
        ...prev,
        invoiceNo: confirmedInvoiceNo
      }));

      // Generate the canonical full PDF.
      const pdfBlob = await stampInvoice(
        {
          ...invoiceData,
          invoiceNo: confirmedInvoiceNo
        },
        enrichedTotals,
        isChallan ? 'challan' : 'invoice',
        getTemplateKey(),
        'full'
      );

      // Save the canonical PDF in browser storage.
      await saveInvoicePdf(
        confirmedInvoiceId,
        pdfBlob
      );

      console.log(
        'Invoice saved successfully:',
        confirmedInvoiceNo
      );

    } catch (err) {
      console.error('Save invoice error:', err);
      setError(err.message);

    } finally {
      setIsDownloading(false);
    }
  };

  // ---------------------------------------------------------
  // DOWNLOAD INVOICE
  // Generates and downloads only.
  // Does not save a record.
  // ---------------------------------------------------------
  const handleDownload = async () => {
    setIsDownloading(true);
    setError(null);

    try {
      const invoiceNo =
        savedInvoiceNo ||
        invoiceData.invoiceNo ||
        'Preview';

      const templateKey = getTemplateKey();

      const pdfBlob = await stampInvoice(
        {
          ...invoiceData,
          invoiceNo
        },
        enrichedTotals,
        isChallan ? 'challan' : 'invoice',
        templateKey,
        'full'
      );

      let blob = pdfBlob;

      if (selectedFormat === 'jpg') {
        const jpgSourcePdf = await stampInvoice(
          {
            ...invoiceData,
            invoiceNo
          },
          enrichedTotals,
          isChallan ? 'challan' : 'invoice',
          templateKey,
          templateKey === 'master'
            ? 'print'
            : 'full'
        );

        blob = await convertPdfToJpeg(
          jpgSourcePdf
        );
      }

      const extension =
        selectedFormat === 'jpg'
          ? 'jpg'
          : 'pdf';

      const mimeType =
        selectedFormat === 'jpg'
          ? 'image/jpeg'
          : 'application/pdf';

      const filename =
        `iCanBill-${isChallan ? 'Challan' : 'Invoice'}-${invoiceNo}.${extension}`;

      download(
        blob,
        filename,
        mimeType
      );

    } catch (err) {
      console.error(
        'Download invoice error:',
        err
      );

      setError(err.message);

    } finally {
      setIsDownloading(false);
    }
  };

  const docLabel = isChallan
    ? 'Challan'
    : 'Invoice';
  const activePageLabel = {
    overview: 'Overview',
    user: 'Overview',
    clients: 'Clients',
    billing: 'Billing',
    generator: 'Invoice generator',
    settings: 'Settings',
    retail: 'Retail billing',
    'purchase-orders': 'Purchase orders',
    payments: 'Payments',
    organizer: 'Organizer',
    quotations: 'Quotations',
  }[activeTab] || 'Workspace';

  return (
    <div
      className="app-wrapper"
      style={{
        width: '100vw',
        maxWidth: '100%',
        margin: 0,
        paddingTop: '68px',
        boxSizing: 'border-box',
        overflowX: 'hidden'
      }}
    >
      <nav
        className="navbar"
        style={{
          width: '100%',
          boxSizing: 'border-box'
        }}
      >
        <div className="workspace-topbar-context">
          <span className="workspace-topbar-mark" aria-hidden="true" />
          <div>
            <span className="workspace-topbar-label">
              {workspaceMode === 'retail' ? 'RETAIL WORKSPACE' : 'BUSINESS WORKSPACE'}
            </span>
            <strong>{activePageLabel}</strong>
          </div>
        </div>

        <div className="workspace-topbar-actions">
          <span className="workspace-topbar-local">
            <span />
            Signed-in workspace
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => supabase.auth.signOut()}
            style={{ borderRadius: '9px', padding: '9px 14px' }}
          >
            Sign out
          </button>
          {activeTab === 'generator' && (
            <button
              className="btn btn-sm"
              onClick={handleSave}
              disabled={isDownloading || savedInvoiceId}
              title="Save Invoice"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px',
                borderRadius: '9px',
                padding: '9px 14px'
              }}
            >
              {isDownloading ? (
                <>
                  <Loader2
                    size={15}
                    className="spin"
                  />
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <Save size={15} />
                  <span>
                    {savedInvoiceId
                      ? 'Saved'
                      : 'Save Invoice'}
                  </span>
                </>
              )}
            </button>
          )}
        </div>
      </nav>

      <main
        className="main-content"
        style={{
          padding: 0,
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          margin: 0
        }}
      >

        {error && (
          <div
            className="error-banner"
            style={{
              margin: '20px'
            }}
          >
            <AlertCircle
              size={16}
              style={{
                flexShrink: 0,
                marginTop: 1
              }}
            />

            <span>{error}</span>
          </div>
        )}

        {workspaceSetupRequired && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-setup-title"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1200,
              display: 'grid',
              placeItems: 'center',
              padding: '20px',
              background: 'rgba(20, 35, 48, .58)',
            }}
          >
            <section style={{ width: 'min(560px, 100%)', padding: '28px', borderRadius: '16px', background: '#fff', boxShadow: '0 24px 70px rgba(0,0,0,.24)' }}>
              <span style={{ color: '#087d73', fontSize: '10px', fontWeight: 800, letterSpacing: '1px' }}>WELCOME TO ICANBILL</span>
              <h1 id="workspace-setup-title" style={{ margin: '8px 0', color: '#172033', fontSize: '25px' }}>Choose your workspace</h1>
              <p style={{ margin: '0 0 18px', color: '#687486', fontSize: '13px' }}>Pick the workspace that best fits your business. You can switch modes later in Settings.</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '12px' }}>
                {[
                  { id: 'retail', title: 'Retail', description: 'Barcode checkout, catalog, and stock.' },
                  { id: 'business', title: 'Business', description: 'Customer POs, orders, and invoices.' },
                ].map(mode => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => changeWorkspaceMode(mode.id)}
                    style={{ padding: '18px', border: '1px solid #dfe8e8', borderRadius: '12px', background: '#f9fcfb', color: '#26364a', textAlign: 'left', cursor: 'pointer' }}
                  >
                    <strong style={{ display: 'block', marginBottom: '6px', fontSize: '15px' }}>{mode.title} Mode</strong>
                    <span style={{ color: '#718091', fontSize: '12px' }}>{mode.description}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {activeTab === 'overview' ||
        activeTab === 'user' ? (

          <OverviewDashboard
            onNewInvoice={(client) => {
              if (client) {
                setInvoiceData(prev => ({
                  ...prev,
                  clientName: client.client_name || '',
                  clientGstin: client.gst_no || '',
                  clientAddress: client.address || ''
                }));
              }
              navigateToTab('generator');
            }}
            onOpenBilling={() =>
              navigateToTab('billing')
            }
            onNavigate={navigateToTab}
            activeView={activeTab}
            workspaceMode={workspaceMode}
          />

        ) : activeTab === 'clients' ? (

          <ClientsDashboard
            onNavigate={navigateToTab}
            workspaceMode={workspaceMode}
            onNewInvoice={(client, order) => {
              setInvoiceData(prev => ({
                ...prev,
                clientName: client?.client_name || '',
                clientGstin: client?.gst_no || '',
                clientAddress: client?.address || ''
              }));
              if (order) {
                setItems([{
                  description: order.requirement || '',
                  hsn: '',
                  quantity: Number(order.quantity) || 1,
                  rate: 0,
                  baseRate: 0,
                  per: 'Nos'
                }]);
              }
              navigateToTab('generator');
            }}
          />

        ) : activeTab === 'billing' ? (

          <Dashboard
            onNewInvoice={() =>
              navigateToTab('generator')
            }
            onNavigate={navigateToTab}
            workspaceMode={workspaceMode}
          />

        ) : activeTab === 'settings' ? (

          <WorkspaceSettings
            workspaceMode={workspaceMode}
            onWorkspaceModeChange={changeWorkspaceMode}
            onNavigate={navigateToTab}
          />

        ) : activeTab === 'retail' ? (

          <RetailBilling
            onNavigate={navigateToTab}
            workspaceMode={workspaceMode}
            onCheckout={handleRetailCheckout}
          />

        ) : activeTab === 'purchase-orders' ? (

          <PurchaseOrdersDashboard
            onCreateInvoice={handleCreateInvoiceFromPurchaseOrder}
            onNavigate={navigateToTab}
            workspaceMode={workspaceMode}
          />

        ) : activeTab === 'payments' ? (

          <PaymentsDashboard
            onNavigate={navigateToTab}
            workspaceMode={workspaceMode}
          />

        ) : activeTab === 'organizer' ? (

          <OrganizerDashboard
            onNavigate={navigateToTab}
            workspaceMode={workspaceMode}
          />

        ) : activeTab === 'quotations' ? (

          <QuotationsDashboard
            onNavigate={navigateToTab}
            workspaceMode={workspaceMode}
            onCreateInvoice={handleCreateInvoiceFromQuotation}
          />

        ) : (

          <div
            style={{
              display: 'flex',
              minHeight: 'calc(100vh - 60px)',
              width: '100%',
              background: '#f7f9fc'
            }}
          >

            <WorkspaceSidebar
              activeView="generator"
              onNavigate={navigateToTab}
              workspaceMode={workspaceMode}
            />

            <div
              style={{
                flex: 1,
                minWidth: 0,
                padding: '20px',
                boxSizing: 'border-box'
              }}
            >

              <InvoiceForm
                invoiceData={invoiceData}
                setInvoiceData={setInvoiceData}
                items={items}
                setItems={setItems}
              />

            </div>

          </div>

        )}

      </main>

      {/* BOTTOM ACTION BAR */}
      {activeTab === 'generator' && (
        <div
          className="action-bar"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
            boxSizing: 'border-box'
          }}
        >

          <div
            className="action-bar-info"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '15px'
            }}
          >

            <div>
              <strong>
                {docLabel} #
                {invoiceData.invoiceNo || '—'}
              </strong>

              {invoiceData.clientName && (
                <>
                  &nbsp;·&nbsp;
                  {invoiceData.clientName}
                </>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '13px',
                background: 'rgba(255,255,255,0.08)',
                padding: '4px 10px',
                borderRadius: '6px'
              }}
            >

              <span style={{ opacity: 0.8 }}>
                Status:
              </span>

              <select
                value={invoiceData.status}
                onChange={e =>
                  setInvoiceData(prev => ({
                    ...prev,
                    status: e.target.value
                  }))
                }
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  fontWeight: '500',
                  cursor: 'pointer',
                  outline: 'none'
                }}
              >

                <option
                  value="Successful"
                  style={{ color: '#000' }}
                >
                  Successful
                </option>

                <option
                  value="Paid"
                  style={{ color: '#000' }}
                >
                  Paid
                </option>

                <option
                  value="Pending"
                  style={{ color: '#000' }}
                >
                  Pending
                </option>

                <option
                  value="Cancelled"
                  style={{ color: '#000' }}
                >
                  Cancelled
                </option>

              </select>

            </div>

          </div>

          <div className="action-bar-buttons">

            <select
              value={copyType}
              onChange={e =>
                setCopyType(e.target.value)
              }
              style={{
                padding: '10px 14px',
                borderRadius: '10px',
                border: '1px solid #cbd5e1',
                background: '#fff',
                fontSize: '13px',
                fontWeight: '600',
                color: '#00665e',
                cursor: 'pointer'
              }}
            >

              <option value="Master Copy">
                Master Copy
              </option>

              <option value="Office Copy">
                Office Copy
              </option>

              <option value="DCCHALLAN">
                DCCHALLAN
              </option>

            </select>

            <select
              value={selectedFormat}
              onChange={e =>
                setSelectedFormat(e.target.value)
              }
              aria-label={`${copyType} output format`}
              style={{
                padding: '10px 14px',
                borderRadius: '10px',
                border: '1px solid #cbd5e1',
                background: '#fff',
                fontSize: '13px',
                fontWeight: '600',
                color: '#00665e',
                cursor: 'pointer'
              }}
            >

              <option value="pdf">
                PDF
              </option>

              <option value="jpg">
                JPG
              </option>

            </select>

            {/* PREVIEW */}
            <button
              type="button"
              className="btn btn-outline"
              onClick={handlePreview}
              disabled={
                isGenerating ||
                isDownloading
              }
            >

              {isGenerating ? (
                <>
                  <Loader2
                    size={15}
                    className="spin"
                  />
                  Generating…
                </>
              ) : (
                <>
                  <Eye size={15} />
                  Preview {docLabel}
                </>
              )}

            </button>

            {/* DOWNLOAD */}
            <button
              className="btn"
              onClick={handleDownload}
              disabled={
                isGenerating ||
                isDownloading
              }
            >

              {isDownloading ? (
                <>
                  <Loader2
                    size={15}
                    className="spin"
                  />
                  Downloading…
                </>
              ) : (
                <>
                  <Download size={15} />
                  Download {docLabel}
                </>
              )}

            </button>

          </div>

        </div>
      )}

      {/* PREVIEW MODAL */}
      {showModal && (
        <div
          className="modal-backdrop"
          onClick={closeModal}
        >

          <div
            className="modal"
            onClick={e =>
              e.stopPropagation()
            }
          >

            <div className="modal-header">

              <div className="modal-title">
                <FileText size={17} />

                {docLabel} Preview —
                #{invoiceData.invoiceNo}
              </div>

              <div className="modal-actions">

                <button
                  className="btn btn-sm"
                  onClick={handleDownload}
                  disabled={isDownloading}
                >

                  {isDownloading ? (
                    <>
                      <Loader2
                        size={13}
                        className="spin"
                      />
                      Downloading…
                    </>
                  ) : (
                    <>
                      <Download size={13} />
                      Download
                    </>
                  )}

                </button>

                <button
                  className="btn btn-sm btn-ghost"
                  onClick={closeModal}
                >
                  <X size={15} />
                </button>

              </div>

            </div>

            <div className="modal-body">

              {previewError ? (
                <div className="modal-loading" role="alert">
                  {previewError}
                </div>
              ) : previewUrl ? (

                selectedFormat === 'jpg' ? (

                  <img
                    src={previewUrl}
                    alt={`${copyType} preview`}
                    style={{
                      display: 'block',
                      width: '100%',
                      height: 'auto'
                    }}
                  />

                ) : (

                  <iframe
                    src={previewUrl}
                    title="Bill Preview"
                  />

                )

              ) : (

                <div className="modal-loading">

                  <Loader2
                    size={28}
                    className="spin"
                    style={{
                      color: 'var(--cc-teal)'
                    }}
                  />

                  <span>
                    Rendering…
                  </span>

                </div>

              )}

            </div>

          </div>

        </div>
      )}

    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <InvoiceWorkspace />
    </AuthGate>
  );
}
