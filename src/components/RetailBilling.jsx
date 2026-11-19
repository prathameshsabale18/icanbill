import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Barcode,
  Camera,
  Package,
  Pencil,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  TrendingUp,
  Upload,
  X,
} from 'lucide-react';
import { localData } from '../localDataClient';
import { calculateTotals } from '../utils/calculations';
import { calculateInvoiceReportTotals, getInvoiceDateKey } from '../utils/invoiceReportPdf';
import WorkspaceSidebar from './WorkspaceSidebar';

const money = value => `₹${Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

const readPrice = product => {
  const direct = Number(product.price ?? product.unit_price);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const rateText = String(product.rates || '');
  const rateMatch = rateText.match(/@\s*([\d.]+)/);
  return Number(rateMatch?.[1] || rateText) || 0;
};

const productName = product => [
  product.product || product.name || 'Product',
  product.size && `Size ${product.size}`,
  product.color && `Color ${product.color}`,
].filter(Boolean).join(' · ');

const blankProduct = barcode => ({
  product: '',
  sku: '',
  barcode: barcode || '',
  category: '',
  brand: '',
  size: '',
  color: '',
  hsn: '',
  spec: 'Nos',
  purchase_price: '',
  price: '',
  stock: '',
});

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(field.trim());
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field.trim());
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
  row.push(field.trim());
  if (row.some(value => value !== '')) rows.push(row);
  if (rows.length < 2) throw new Error('The CSV must include a header and at least one product.');

  const headers = rows[0].map(value =>
    value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  );
  return rows.slice(1).map((values, index) => ({
    line: index + 2,
    values: Object.fromEntries(headers.map((header, column) => [header, values[column] || ''])),
  }));
}

const csvValue = (row, ...headers) => {
  const header = headers.find(name => row.values[name] !== undefined);
  return header ? String(row.values[header]).trim() : '';
};

const todayDateKey = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};
const inventoryGridColumns = 'minmax(160px, 1.8fr) minmax(75px, .8fr) minmax(110px, 1fr) minmax(85px, .8fr) minmax(85px, .8fr) minmax(90px, .8fr) minmax(90px, .8fr) minmax(55px, .5fr) minmax(85px, .8fr) minmax(115px, 1.1fr) 70px';

export default function RetailBilling({ onNavigate, workspaceMode, onCheckout }) {
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [stockEdits, setStockEdits] = useState({});
  const [cart, setCart] = useState([]);
  const [barcode, setBarcode] = useState('');
  const [search, setSearch] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [otherPaymentMethod, setOtherPaymentMethod] = useState(
    () => localStorage.getItem('billing_mvp_other_payment_method') || ''
  );
  const [amountReceived, setAmountReceived] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showProductForm, setShowProductForm] = useState(false);
  const [productForm, setProductForm] = useState(blankProduct);
  const [editingProductId, setEditingProductId] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const barcodeRef = useRef(null);
  const csvInputRef = useRef(null);
  const videoRef = useRef(null);

  const refreshProducts = async () => {
    const { data, error: resultError } = await localData
      .from('products')
      .select('*')
      .order('product', { ascending: true });
    if (resultError) {
      setError(resultError.message);
      return;
    }
    setProducts(data || []);
  };

  const refreshSales = async () => {
    const { data: invoices, error: invoiceError } = await localData
      .from('invoices')
      .select('*')
      .order('id', { ascending: false });
    if (invoiceError) {
      setError(invoiceError.message);
      return;
    }

    const invoiceRows = invoices || [];
    const invoiceIds = invoiceRows.map(invoice => invoice.id);
    const { data: invoiceItems, error: itemError } = invoiceIds.length
      ? await localData.from('invoice_items').select('*').in('invoice_id', invoiceIds)
      : { data: [], error: null };
    if (itemError) {
      setError(itemError.message);
      return;
    }

    const itemsByInvoice = new Map();
    (invoiceItems || []).forEach(item => {
      const current = itemsByInvoice.get(String(item.invoice_id)) || [];
      current.push(item);
      itemsByInvoice.set(String(item.invoice_id), current);
    });
    setSales(invoiceRows.map(invoice => ({
      ...invoice,
      items: itemsByInvoice.get(String(invoice.id)) || [],
    })));
  };

  useEffect(() => {
    refreshProducts();
  }, []);

  useEffect(() => {
    refreshSales();
  }, []);

  const filteredProducts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    return products.filter(product =>
      [product.product, product.sku, product.brand, product.category, product.barcode, product.size, product.color]
        .some(value => String(value || '').toLowerCase().includes(needle))
    ).slice(0, 8);
  }, [products, search]);

  const todaySales = useMemo(() => sales.filter(invoice =>
    getInvoiceDateKey(invoice.date || invoice.invoice_date) === todayDateKey()
  ), [sales]);
  const todayRevenue = todaySales.reduce(
    (total, invoice) => total + calculateInvoiceReportTotals(invoice).grandTotal,
    0
  );
  const outstandingBalance = sales.reduce((total, invoice) => {
    const invoiceTotal = calculateInvoiceReportTotals(invoice).grandTotal;
    return total + Math.max(0, invoiceTotal - Number(invoice.amount_paid || 0));
  }, 0);
  const lowStockProducts = useMemo(() => products.filter(product =>
    Number(product.stock ?? product.quantity ?? 0) <= 5
  ), [products]);
  const bestSellingProducts = useMemo(() => {
    const quantities = new Map();
    sales.forEach(invoice => invoice.items.forEach(item => {
      const key = String(item.product_id || item.description || '');
      if (!key) return;
      const entry = quantities.get(key) || {
        name: item.description || 'Product',
        quantity: 0,
      };
      entry.quantity += Number(item.quantity || 0);
      quantities.set(key, entry);
    }));
    return [...quantities.values()]
      .sort((left, right) => right.quantity - left.quantity)
      .slice(0, 3);
  }, [sales]);

  const addProductToCart = useCallback(product => {
    setError('');
    setNotice('');
    setCart(current => {
      const existing = current.find(item => String(item.productId) === String(product.id));
      if (existing) {
        return current.map(item => item === existing
          ? { ...item, quantity: Number(item.quantity) + 1 }
          : item);
      }
      return [...current, {
        productId: product.id,
        sku: product.sku || '',
        barcode: product.barcode || '',
        description: productName(product),
        hsn: product.hsn || '',
        per: product.spec || 'Nos',
        quantity: 1,
        listRate: readPrice(product),
        stock: Number(product.stock ?? product.quantity ?? 0),
      }];
    });
    setSearch('');
    setBarcode('');
    barcodeRef.current?.focus();
  }, []);

  const addBarcodeToCart = useCallback(scanned => {
    const product = products.find(item => String(item.barcode || '').trim() === scanned);
    if (!product) {
      setError(`No product is registered for barcode ${scanned}. Add it to the catalog first.`);
      setEditingProductId(null);
      setProductForm(blankProduct(scanned));
      setShowProductForm(true);
      return false;
    }
    addProductToCart(product);
    return true;
  }, [products, addProductToCart]);

  const handleBarcode = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const scanned = barcode.trim();
    if (!scanned) return;
    addBarcodeToCart(scanned);
  };

  useEffect(() => {
    if (!cameraOpen) return undefined;
    let active = true;
    let stream;
    let timer;
    let detecting = false;
    const videoElement = videoRef.current;

    const startCamera = async () => {
      if (!videoElement) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof window.BarcodeDetector !== 'function') {
        setCameraError('Camera barcode scanning is not supported in this browser. Use the barcode field instead.');
        return;
      }

      try {
        const detector = new window.BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'],
        });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
        if (!active) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        videoElement.srcObject = stream;
        await videoElement.play();
        timer = window.setInterval(async () => {
          if (detecting || !active) return;
          detecting = true;
          try {
            const [result] = await detector.detect(videoElement);
            if (result?.rawValue && active) {
              addBarcodeToCart(String(result.rawValue).trim());
              setCameraOpen(false);
            }
          } catch (scanError) {
            setCameraError(`Could not read the barcode: ${scanError.message}`);
          } finally {
            detecting = false;
          }
        }, 350);
      } catch (cameraStartError) {
        setCameraError(`Could not start the camera: ${cameraStartError.message}`);
      }
    };

    startCamera();
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
      stream?.getTracks().forEach(track => track.stop());
      if (videoElement) videoElement.srcObject = null;
    };
  }, [cameraOpen, addBarcodeToCart]);

  const changeCartItem = (index, field, value) => {
    setCart(current => current.map((item, itemIndex) => (
      itemIndex === index
        ? { ...item, [field]: value }
        : item
    )));
  };

  const subtotal = cart.reduce(
    (sum, item) => sum + Number(item.quantity || 0) * Number(item.listRate || 0),
    0
  );
  const discountAmount = subtotal * Math.max(0, Math.min(100, Number(discount) || 0)) / 100;
  const saleItems = cart.map(item => {
    const discountedRate = Number(item.listRate || 0) * (1 - Math.max(0, Math.min(100, Number(discount) || 0)) / 100);
    return {
      ...item,
      rate: discountedRate,
      baseRate: discountedRate,
      originalRate: Number(item.listRate || 0),
      discountPercent: Math.max(0, Math.min(100, Number(discount) || 0)),
    };
  });
  const totals = calculateTotals(saleItems, '', 0);

  const saveProduct = async event => {
    event.preventDefault();
    setError('');
    const nextProduct = {
      ...productForm,
      product: productForm.product.trim(),
      sku: productForm.sku.trim(),
      barcode: productForm.barcode.trim(),
      price: Number(productForm.price),
      purchase_price: productForm.purchase_price === ''
        ? null
        : Number(productForm.purchase_price),
      stock: Number(productForm.stock),
      rates: `${productForm.spec || 'Nos'} @ ${Number(productForm.price)}`,
      category: productForm.category.trim(),
      brand: productForm.brand.trim(),
      spec: productForm.spec || 'Nos',
    };
    if (
      !nextProduct.product ||
      !nextProduct.barcode ||
      !Number.isFinite(nextProduct.price) ||
      nextProduct.price < 0 ||
      (nextProduct.purchase_price !== null &&
        (!Number.isFinite(nextProduct.purchase_price) || nextProduct.purchase_price < 0)) ||
      !Number.isInteger(nextProduct.stock) ||
      nextProduct.stock < 0
    ) {
      setError('Enter a product name, unique barcode, valid price, and non-negative stock.');
      return;
    }
    if (products.some(item =>
      String(item.barcode || '').trim() === nextProduct.barcode &&
      String(item.id) !== String(editingProductId)
    )) {
      setError(`Barcode ${nextProduct.barcode} is already assigned to a product.`);
      return;
    }
    const result = await localData.atomic(database => {
      const duplicate = database.products.find(item =>
        String(item.barcode || '').trim() === nextProduct.barcode &&
        String(item.id) !== String(editingProductId)
      );
      if (duplicate) {
        throw new Error(`Barcode ${nextProduct.barcode} is already assigned to a product.`);
      }

      const now = new Date().toISOString();
      if (editingProductId !== null) {
        const existingIndex = database.products.findIndex(item =>
          String(item.id) === String(editingProductId)
        );
        if (existingIndex < 0) throw new Error('This product was removed from the catalog.');
        database.products[existingIndex] = {
          ...database.products[existingIndex],
          ...nextProduct,
          updated_at: now,
        };
        return 'updated';
      }

      const id = database.products.reduce((maximum, item) =>
        Number.isFinite(Number(item.id)) ? Math.max(maximum, Number(item.id)) : maximum
      , 0) + 1;
      database.products.push({
        ...nextProduct,
        id,
        created_at: now,
        updated_at: now,
      });
      return 'added';
    });
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setShowProductForm(false);
    setEditingProductId(null);
    setProductForm(blankProduct());
    setNotice(result.data === 'updated' ? 'Product updated.' : 'Product added to the shared catalog.');
    await refreshProducts();
  };

  const importProductsCsv = async event => {
    const [file] = event.target.files || [];
    event.target.value = '';
    if (!file) return;

    setError('');
    setNotice('');
    let rows;
    try {
      rows = parseCsv(await file.text());
    } catch (csvError) {
      setError(csvError.message);
      return;
    }

    const knownBarcodes = new Set(products.map(product =>
      String(product.barcode || '').trim()
    ).filter(Boolean));
    const imported = [];
    const errors = [];

    rows.forEach(row => {
      const product = csvValue(row, 'product', 'product_name', 'name');
      const barcodeValue = csvValue(row, 'barcode', 'ean', 'upc');
      const priceValue = csvValue(row, 'selling_price', 'price', 'unit_price');
      const stockValue = csvValue(row, 'stock', 'quantity');
      const price = Number(priceValue);
      const stock = Number(stockValue);
      if (!product || !barcodeValue) {
        errors.push(`Line ${row.line}: product name and barcode are required.`);
        return;
      }
      if (knownBarcodes.has(barcodeValue)) {
        errors.push(`Line ${row.line}: barcode ${barcodeValue} is duplicated.`);
        return;
      }
      if (!priceValue || !Number.isFinite(price) || price < 0) {
        errors.push(`Line ${row.line}: selling price must be a non-negative number.`);
        return;
      }
      if (!stockValue || !Number.isInteger(stock) || stock < 0) {
        errors.push(`Line ${row.line}: stock must be a non-negative whole number.`);
        return;
      }
      knownBarcodes.add(barcodeValue);
      const purchasePriceValue = csvValue(row, 'purchase_price', 'cost_price');
      const purchasePrice = purchasePriceValue === '' ? null : Number(purchasePriceValue);
      if (purchasePrice !== null && (!Number.isFinite(purchasePrice) || purchasePrice < 0)) {
        errors.push(`Line ${row.line}: purchase price must be blank or a non-negative number.`);
        return;
      }
      const spec = csvValue(row, 'unit', 'uom', 'spec') || 'Nos';
      imported.push({
        product,
        sku: csvValue(row, 'sku'),
        barcode: barcodeValue,
        category: csvValue(row, 'category'),
        brand: csvValue(row, 'brand'),
        size: csvValue(row, 'size'),
        color: csvValue(row, 'color', 'colour'),
        hsn: csvValue(row, 'hsn', 'hsn_code', 'tax_code'),
        spec,
        purchase_price: purchasePrice,
        price,
        stock,
        rates: `${spec} @ ${price}`,
      });
    });

    if (errors.length) {
      setError(`CSV import stopped; no products were added. ${errors.slice(0, 3).join(' ')}`);
      return;
    }
    if (!imported.length) {
      setError('The CSV did not contain any product rows.');
      return;
    }

    const importResult = await localData.atomic(database => {
      const currentBarcodes = new Set(database.products.map(product =>
        String(product.barcode || '').trim()
      ).filter(Boolean));
      const batchBarcodes = new Set();
      imported.forEach(product => {
        if (currentBarcodes.has(product.barcode) || batchBarcodes.has(product.barcode)) {
          throw new Error(`Barcode ${product.barcode} is already assigned to a product.`);
        }
        batchBarcodes.add(product.barcode);
      });
      let nextId = database.products.reduce((maximum, product) =>
        Number.isFinite(Number(product.id)) ? Math.max(maximum, Number(product.id)) : maximum
      , 0) + 1;
      const now = new Date().toISOString();
      database.products.push(...imported.map(product => ({
        ...product,
        id: nextId++,
        created_at: now,
        updated_at: now,
      })));
      return imported.length;
    });
    if (importResult.error) {
      setError(`CSV import failed: ${importResult.error.message}`);
      return;
    }
    setNotice(`Imported ${imported.length} product${imported.length === 1 ? '' : 's'} from CSV.`);
    await refreshProducts();
  };

  const editProduct = product => {
    setError('');
    setEditingProductId(product.id);
    setProductForm({
      ...blankProduct(),
      ...product,
      purchase_price: product.purchase_price ?? '',
      price: readPrice(product),
      stock: Number(product.stock ?? product.quantity ?? 0),
    });
    setShowProductForm(true);
  };

  const saveStock = async product => {
    const stock = Number(stockEdits[product.id]);
    if (!Number.isInteger(stock) || stock < 0) {
      setError('Stock must be a non-negative whole number.');
      return;
    }
    const { error: updateError } = await localData
      .from('products')
      .update({ stock })
      .eq('id', product.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setStockEdits(current => {
      const next = { ...current };
      delete next[product.id];
      return next;
    });
    setNotice(`${product.product} stock updated.`);
    setError('');
    await refreshProducts();
  };

  const deleteProduct = async product => {
    if (!window.confirm(`Remove ${product.product} from the product catalog? Historical invoices will remain unchanged.`)) return;
    const { error: deleteError } = await localData
      .from('products')
      .delete()
      .eq('id', product.id);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setCart(current => current.filter(item => String(item.productId) !== String(product.id)));
    setNotice(`${product.product} removed from the catalog.`);
    setError('');
    await refreshProducts();
  };

  const checkout = async () => {
    setError('');
    setNotice('');
    if (!cart.length) {
      setError('Scan a barcode or add a product before checkout.');
      return;
    }
    const outOfStock = cart.find(item =>
      item.quantity === '' ||
      Number(item.quantity) <= 0 ||
      Number(item.quantity) > item.stock
    );
    if (outOfStock) {
      setError(`${outOfStock.description} has only ${outOfStock.stock} in stock.`);
      return;
    }
    const received = amountReceived === ''
      ? totals.grandTotal
      : Number(amountReceived);
    if (!Number.isFinite(received) || received < 0) {
      setError('Enter a valid non-negative payment amount.');
      return;
    }
    const amountPaid = Math.min(received, totals.grandTotal);
    const selectedPaymentMethod = paymentMethod === 'Other'
      ? otherPaymentMethod.trim() || 'Other'
      : paymentMethod;
    setBusy(true);
    try {
      const result = await onCheckout({
        invoiceData: {
          invoiceNo: '',
          invoiceDate: new Date().toLocaleDateString('en-GB'),
          clientName: customerName.trim() || 'Walk-in customer',
          clientAddress: '',
          clientGstin: '',
          gstRate: 18,
          poNo: '',
          freight: 0,
          status: amountPaid >= totals.grandTotal ? 'Paid' : amountPaid > 0 ? 'Partially Paid' : 'Pending',
          amountPaid,
          paymentMethod: amountPaid > 0 ? selectedPaymentMethod : '',
          docType: 'TAX_INVOICE',
        },
        items: saleItems,
      });
      if (!result?.success) {
        setError(result?.error || 'The sale could not be completed.');
        return;
      }
      setNotice(result.warning || `Sale ${result.invoiceNo} saved. Stock was updated.`);
      setCart([]);
      setCustomerName('');
      setDiscount(0);
      setAmountReceived('');
      await Promise.all([refreshProducts(), refreshSales()]);
      barcodeRef.current?.focus();
    } catch (checkoutError) {
      setError(checkoutError.message);
    } finally {
      setBusy(false);
    }
  };

  const supportsCameraScan = typeof window !== 'undefined' &&
    typeof window.BarcodeDetector === 'function' &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const changeDue = Math.max(
    0,
    Number(amountReceived === '' ? totals.grandTotal : amountReceived) - totals.grandTotal
  );
  return (
    <div className="retail-shell" style={{ display: 'flex', minHeight: 'calc(100vh - 68px)', background: '#f7f9fc' }}>
      <WorkspaceSidebar activeView="retail" onNavigate={onNavigate} workspaceMode={workspaceMode} />
      <main className="retail-main" style={{ flex: 1, minWidth: 0, padding: '24px', boxSizing: 'border-box' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' }}>
          <div>
            <div style={{ color: '#087d73', fontSize: '11px', fontWeight: 800, letterSpacing: '.08em' }}>RETAIL / CHECKOUT</div>
            <h1 style={{ margin: '5px 0', color: '#172033' }}>Barcode billing</h1>
            <p style={{ margin: 0, color: '#788496', fontSize: '13px' }}>Scan a product barcode, or find it by name, size, or colour.</p>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {supportsCameraScan && (
              <button type="button" onClick={() => {
                setCameraError('');
                setCameraOpen(true);
              }} style={secondaryButton}>
                <Camera size={16} /> Camera scan
              </button>
            )}
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label="Import products from CSV"
              style={{ display: 'none' }}
              onChange={importProductsCsv}
            />
            <button type="button" onClick={() => csvInputRef.current?.click()} style={secondaryButton}>
              <Upload size={15} /> Import CSV
            </button>
            <button type="button" onClick={() => {
              setEditingProductId(null);
              setProductForm(blankProduct());
              setShowProductForm(true);
            }} style={primaryButton}>
              <Plus size={16} /> Add product
            </button>
          </div>
        </header>

        {notice && <p role="status" style={noticeStyle}>{notice}</p>}
        {error && <p role="alert" style={errorStyle}>{error}</p>}

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '11px', marginBottom: '16px' }}>
          <RetailMetric label="Today's sales" value={money(todayRevenue)} note={`${todaySales.length} invoice${todaySales.length === 1 ? '' : 's'} today`} />
          <RetailMetric label="Total invoices" value={sales.length} note="All recorded transactions" />
          <RetailMetric label="Pending payments" value={money(outstandingBalance)} note="Outstanding invoice balance" />
          <RetailMetric label="Low stock" value={lowStockProducts.length} note="Products at 5 or fewer units" warning={lowStockProducts.length > 0} />
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, .8fr)', gap: '12px', marginBottom: '18px' }}>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', color: '#173b36', fontWeight: 700 }}>
              <TrendingUp size={16} color="#087d73" /> Recent transactions
            </div>
            {sales.slice(0, 4).length ? sales.slice(0, 4).map(invoice => (
              <div key={invoice.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderTop: '1px solid #edf1f4', fontSize: '12px' }}>
                <span><strong>{invoice.invoice_no || 'Invoice'}</strong><small style={{ display: 'block', marginTop: '3px', color: '#8792a0' }}>{invoice.client_name || 'Walk-in customer'} · {invoice.date || invoice.invoice_date || ''}</small></span>
                <strong>{money(calculateInvoiceReportTotals(invoice).grandTotal)}</strong>
              </div>
            )) : <p style={{ margin: 0, color: '#8792a0', fontSize: '12px' }}>Sales will appear here after the first checkout.</p>}
          </div>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', color: '#173b36', fontWeight: 700 }}>
              <Package size={16} color="#087d73" /> Best-selling products
            </div>
            {bestSellingProducts.length ? bestSellingProducts.map(item => (
              <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderTop: '1px solid #edf1f4', fontSize: '12px' }}>
                <span>{item.name}</span><strong>{item.quantity} sold</strong>
              </div>
            )) : <p style={{ margin: 0, color: '#8792a0', fontSize: '12px' }}>Product rankings appear after sales are recorded.</p>}
            {lowStockProducts.length > 0 && (
              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #edf1f4', color: '#9a6a18', fontSize: '11px' }}>
                Reorder soon: {lowStockProducts.slice(0, 3).map(productName).join(', ')}
              </div>
            )}
          </div>
        </section>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.45fr) minmax(300px, .8fr)', gap: '18px', alignItems: 'start' }}>
          <section style={cardStyle}>
            <label style={labelStyle} htmlFor="retail-barcode"><Barcode size={16} /> Scan barcode</label>
            <input
              id="retail-barcode"
              ref={barcodeRef}
              autoFocus
              value={barcode}
              onChange={event => setBarcode(event.target.value)}
              onKeyDown={handleBarcode}
              placeholder="Scan or enter barcode, then press Enter"
              style={{ ...inputStyle, fontSize: '16px', padding: '13px' }}
            />
            <label style={{ ...labelStyle, marginTop: '18px' }} htmlFor="retail-product-search"><Search size={15} /> Manual product search</label>
            <input
              id="retail-product-search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search name, category, barcode, size, or colour"
              style={inputStyle}
            />
            {search.trim() && (
              <div style={{ marginTop: '8px', border: '1px solid #e3e9ef', borderRadius: '9px', overflow: 'hidden' }}>
                {filteredProducts.length ? filteredProducts.map(product => (
                  <button key={product.id} type="button" onClick={() => addProductToCart(product)} style={resultButton}>
                    <span><strong>{productName(product)}</strong><small>{product.category || 'Product'} · Barcode {product.barcode || 'not set'} · Stock {Number(product.stock ?? product.quantity ?? 0)}</small></span>
                    <strong>{money(readPrice(product))}</strong>
                  </button>
                )) : <div style={{ padding: '13px', color: '#788496', fontSize: '13px' }}>No matching products.</div>}
              </div>
            )}

            <div style={{ marginTop: '22px', border: '1px solid #e7edf1', borderRadius: '10px', overflowX: 'auto' }}>
              <div style={tableHeaderStyle}><span>Product</span><span>Price</span><span>Qty</span><span>Stock</span><span /></div>
              {cart.length ? cart.map((item, index) => (
                <div key={`${item.productId}-${index}`} style={cartRowStyle}>
                  <span><strong>{item.description}</strong><small>{item.barcode || 'No barcode'} · {item.per}</small></span>
                  <span>{money(item.listRate)}</span>
                  <input aria-label={`Quantity for ${item.description}`} type="number" min="1" max={item.stock} step="1" value={item.quantity} onChange={event => changeCartItem(index, 'quantity', event.target.value)} style={qtyInputStyle} />
                  <span>{item.stock}</span>
                  <button type="button" aria-label={`Remove ${item.description}`} onClick={() => setCart(current => current.filter((_, itemIndex) => itemIndex !== index))} style={iconButton}><Trash2 size={16} /></button>
                </div>
              )) : <div style={{ padding: '24px', textAlign: 'center', color: '#8a96a5', fontSize: '13px' }}>Scan a product to start a bill.</div>}
            </div>
          </section>

          <aside style={{ ...cardStyle, position: 'sticky', top: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '18px', color: '#172033', fontWeight: 700 }}><ShoppingCart size={18} color="#087d73" /> Current bill</div>
            <label style={labelStyle} htmlFor="retail-customer">Customer (optional)</label>
            <input id="retail-customer" value={customerName} onChange={event => setCustomerName(event.target.value)} placeholder="Walk-in customer" style={inputStyle} />
            <label style={{ ...labelStyle, marginTop: '16px' }} htmlFor="retail-discount">Bill discount (%)</label>
            <input id="retail-discount" type="number" min="0" max="100" step="0.01" value={discount} onChange={event => setDiscount(event.target.value)} style={inputStyle} />
            <label style={{ ...labelStyle, marginTop: '16px' }} htmlFor="retail-payment-method">Payment method</label>
            <select id="retail-payment-method" value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)} style={inputStyle}>
              <option>Cash</option><option>UPI</option><option>Card</option><option>Other</option>
            </select>
            {paymentMethod === 'Other' && (
              <input
                aria-label="Custom payment method"
                value={otherPaymentMethod}
                onChange={event => {
                  setOtherPaymentMethod(event.target.value);
                  localStorage.setItem('billing_mvp_other_payment_method', event.target.value);
                }}
                placeholder="Name this payment method"
                style={{ ...inputStyle, marginTop: '8px' }}
              />
            )}
            <label style={{ ...labelStyle, marginTop: '16px' }} htmlFor="retail-amount-paid">Amount received</label>
            <input
              id="retail-amount-paid"
              type="number"
              min="0"
              step="0.01"
              value={amountReceived}
              onChange={event => setAmountReceived(event.target.value)}
              placeholder={totals.grandTotal.toFixed(2)}
              style={inputStyle}
            />
            <div style={summaryRow}><span>Subtotal</span><strong>{money(subtotal)}</strong></div>
            <div style={summaryRow}><span>Discount</span><strong>-{money(discountAmount)}</strong></div>
            <div style={summaryRow}><span>GST (existing billing calculation)</span><strong>{money(totals.totalTax)}</strong></div>
            {changeDue > 0 && <div style={summaryRow}><span>Change due</span><strong>{money(changeDue)}</strong></div>}
            <div style={{ ...summaryRow, paddingTop: '14px', borderTop: '1px solid #e8edf1', fontSize: '18px', color: '#087d73' }}><strong>Total</strong><strong>{money(totals.grandTotal)}</strong></div>
            <button type="button" disabled={busy || cart.length === 0} onClick={checkout} style={{ ...primaryButton, width: '100%', marginTop: '18px', opacity: busy || cart.length === 0 ? .55 : 1 }}>
              {busy ? 'Saving sale…' : `Complete sale · ${money(totals.grandTotal)}`}
            </button>
            <p style={{ color: '#8792a0', fontSize: '11px', lineHeight: 1.5, margin: '10px 0 0' }}>The existing invoice and tax logic is used. Product stock decreases after the invoice is saved.</p>
          </aside>
        </div>

        <section style={{ ...cardStyle, marginTop: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <div><h2 style={{ margin: 0, fontSize: '17px', color: '#172033' }}>Inventory</h2><p style={{ margin: '4px 0 0', color: '#788496', fontSize: '12px' }}>Each variant keeps its own barcode, size, colour, price, and stock. CSV columns: product, barcode, selling_price, stock.</p></div>
            <span style={{ color: '#788496', fontSize: '12px' }}>{products.length} products</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ ...tableHeaderStyle, gridTemplateColumns: inventoryGridColumns, minWidth: '960px' }}><span>Product / variant</span><span>SKU</span><span>Barcode</span><span>Brand</span><span>Category</span><span>Cost</span><span>Price</span><span>Stock</span><span>Status</span><span>Adjust stock</span><span /></div>
            {products.map(product => {
              const stock = Number(product.stock ?? product.quantity ?? 0);
              const stockValue = stockEdits[product.id] ?? String(stock);
              return <div key={product.id} style={{ ...cartRowStyle, gridTemplateColumns: inventoryGridColumns, minWidth: '960px' }}>
                <span><strong>{productName(product)}</strong><small>{product.hsn || 'No tax code'}</small></span>
                <span>{product.sku || '—'}</span>
                <span>{product.barcode || '—'}</span>
                <span>{product.brand || '—'}</span>
                <span>{product.category || '—'}</span>
                <span>{product.purchase_price == null ? '—' : money(product.purchase_price)}</span>
                <span>{money(readPrice(product))}</span>
                <span>{stock}</span>
                <span style={{ color: stock === 0 ? '#c34b4b' : stock <= 5 ? '#9a6a18' : '#087d73' }}>{stock === 0 ? 'Out' : stock <= 5 ? 'Low' : 'Available'}</span>
                <span style={{ display: 'flex', gap: '5px' }}><input aria-label={`Set stock for ${productName(product)}`} type="number" min="0" step="1" value={stockValue} onChange={event => setStockEdits(current => ({ ...current, [product.id]: event.target.value }))} style={{ width: '52px', padding: '5px', border: '1px solid #dce3e9', borderRadius: '5px' }} /><button type="button" disabled={String(stockValue) === String(stock)} onClick={() => saveStock(product)} style={{ ...iconButton, minWidth: '36px', opacity: String(stockValue) === String(stock) ? .45 : 1 }}>Save</button></span>
                <span style={{ display: 'flex', gap: '4px' }}>
                  <button type="button" title={`Edit ${productName(product)}`} onClick={() => editProduct(product)} style={iconButton}><Pencil size={14} /></button>
                  <button type="button" title={`Remove ${productName(product)}`} onClick={() => deleteProduct(product)} style={{ ...iconButton, color: '#b44b47' }}><Trash2 size={14} /></button>
                </span>
              </div>;
            })}
            {!products.length && <div style={{ padding: '18px', color: '#788496', fontSize: '13px' }}>No catalog items yet. Add your first product to start barcode billing.</div>}
          </div>
        </section>
      </main>

      {showProductForm && (
        <div style={modalBackdrop} onMouseDown={event => event.target === event.currentTarget && setShowProductForm(false)}>
          <form onSubmit={saveProduct} style={modalStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div><h2 style={{ margin: 0, color: '#172033', fontSize: '19px' }}>{editingProductId ? 'Edit catalog product' : 'Add catalog product'}</h2><p style={{ margin: '5px 0 0', color: '#788496', fontSize: '12px' }}>Each barcode identifies one product variant.</p></div>
              <button type="button" onClick={() => setShowProductForm(false)} style={iconButton}>×</button>
            </div>
            <div style={formGrid}>
              <label style={fieldStyle}>Product name<input required value={productForm.product} onChange={event => setProductForm({ ...productForm, product: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Barcode<input required autoFocus value={productForm.barcode} onChange={event => setProductForm({ ...productForm, barcode: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>SKU<input value={productForm.sku} onChange={event => setProductForm({ ...productForm, sku: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Brand<input value={productForm.brand} onChange={event => setProductForm({ ...productForm, brand: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Category<input value={productForm.category} onChange={event => setProductForm({ ...productForm, category: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Size<input value={productForm.size} onChange={event => setProductForm({ ...productForm, size: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Colour<input value={productForm.color} onChange={event => setProductForm({ ...productForm, color: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Tax code / HSN<input value={productForm.hsn} onChange={event => setProductForm({ ...productForm, hsn: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Unit<input value={productForm.spec} onChange={event => setProductForm({ ...productForm, spec: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Purchase price<input type="number" min="0" step="0.01" value={productForm.purchase_price} onChange={event => setProductForm({ ...productForm, purchase_price: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Selling price<input required type="number" min="0" step="0.01" value={productForm.price} onChange={event => setProductForm({ ...productForm, price: event.target.value })} style={inputStyle} /></label>
              <label style={fieldStyle}>Opening stock<input required type="number" min="0" step="1" value={productForm.stock} onChange={event => setProductForm({ ...productForm, stock: event.target.value })} style={inputStyle} /></label>
            </div>
            {error && <p role="alert" style={errorStyle}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '9px', marginTop: '18px' }}>
              <button type="button" onClick={() => setShowProductForm(false)} style={secondaryButton}>Cancel</button>
              <button type="submit" style={primaryButton}>{editingProductId ? <Pencil size={15} /> : <Plus size={15} />} {editingProductId ? 'Update product' : 'Save product'}</button>
            </div>
          </form>
        </div>
      )}

      {cameraOpen && (
        <div style={modalBackdrop} onMouseDown={event => event.target === event.currentTarget && setCameraOpen(false)}>
          <section aria-label="Camera barcode scanner" style={{ ...modalStyle, width: 'min(540px, 100%)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <div><h2 style={{ margin: 0, color: '#172033', fontSize: '19px' }}>Scan a barcode</h2><p style={{ margin: '5px 0 0', color: '#788496', fontSize: '12px' }}>Hold the product barcode inside the camera frame.</p></div>
              <button type="button" aria-label="Close camera scanner" onClick={() => setCameraOpen(false)} style={iconButton}><X size={16} /></button>
            </div>
            <video ref={videoRef} autoPlay muted playsInline style={{ display: 'block', width: '100%', maxHeight: '55vh', borderRadius: '9px', background: '#142723', objectFit: 'cover' }} />
            {cameraError && <p role="alert" style={errorStyle}>{cameraError}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

function RetailMetric({ label, value, note, warning = false }) {
  return (
    <div style={{ ...cardStyle, minWidth: 0, borderColor: warning ? '#eadbb5' : '#e3e9ef' }}>
      <div style={{ color: '#8792a0', fontSize: '10px', fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase' }}>{label}</div>
      <strong style={{ display: 'block', marginTop: '8px', color: warning ? '#9a6a18' : '#173b36', fontSize: '21px', overflowWrap: 'anywhere' }}>{value}</strong>
      <small style={{ display: 'block', marginTop: '5px', color: '#8792a0', fontSize: '10px' }}>{note}</small>
    </div>
  );
}

const cardStyle = { padding: '20px', border: '1px solid #e3e9ef', borderRadius: '12px', background: '#fff', boxSizing: 'border-box' };
const inputStyle = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '10px 11px', border: '1px solid #dce3e9', borderRadius: '7px', color: '#172033', background: '#fff', outlineColor: '#087d73' };
const labelStyle = { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px', color: '#394456', fontSize: '12px', fontWeight: 700 };
const tableHeaderStyle = { display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) minmax(75px, .8fr) minmax(65px, .6fr) minmax(60px, .6fr) 32px', gap: '10px', padding: '10px', background: '#f6f9fa', color: '#788496', fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', minWidth: '600px' };
const cartRowStyle = { display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) minmax(75px, .8fr) minmax(65px, .6fr) minmax(60px, .6fr) 32px', alignItems: 'center', gap: '10px', padding: '11px 10px', borderTop: '1px solid #edf1f4', color: '#394456', fontSize: '12px', minWidth: '600px' };
const qtyInputStyle = { width: '62px', padding: '6px', border: '1px solid #dce3e9', borderRadius: '6px' };
const iconButton = { display: 'grid', placeItems: 'center', width: '30px', height: '30px', border: 0, borderRadius: '6px', background: '#f5f7f9', color: '#697586', cursor: 'pointer' };
const resultButton = { display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '11px', border: 0, borderBottom: '1px solid #edf1f4', background: '#fff', color: '#243044', textAlign: 'left', cursor: 'pointer' };
const summaryRow = { display: 'flex', justifyContent: 'space-between', gap: '12px', paddingTop: '12px', color: '#596477', fontSize: '13px' };
const primaryButton = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '7px', padding: '10px 14px', border: 0, borderRadius: '7px', background: '#087d73', color: '#fff', fontWeight: 700, cursor: 'pointer' };
const secondaryButton = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '7px', padding: '9px 13px', border: '1px solid #dce3e9', borderRadius: '7px', background: '#fff', color: '#394456', fontWeight: 600, cursor: 'pointer' };
const noticeStyle = { padding: '10px 12px', borderRadius: '7px', background: '#effaf5', color: '#16724e', fontSize: '13px' };
const errorStyle = { padding: '10px 12px', borderRadius: '7px', background: '#fff2f1', color: '#b43f39', fontSize: '13px' };
const modalBackdrop = { position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: '20px', background: 'rgba(20,30,45,.42)' };
const modalStyle = { width: 'min(560px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: '22px', borderRadius: '13px', background: '#fff', boxSizing: 'border-box' };
const formGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' };
const fieldStyle = { display: 'grid', gap: '6px', color: '#596477', fontSize: '12px', fontWeight: 700 };
