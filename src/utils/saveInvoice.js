import { localData } from '../localDataClient';
import {
  calculateInvoiceItemAmount,
  calculateInvoiceReportTotals
} from './invoiceReportPdf';
import { toStoredInvoiceDate } from './invoiceDates';

const INVOICE_SERIES_PREFIX = 'INV-';

function nextNumericId(rows) {
  return rows.reduce((maximum, row) => {
    const id = Number(row.id);
    return Number.isFinite(id) ? Math.max(maximum, id) : maximum;
  }, 0) + 1;
}

function nextInvoiceNumber(rows) {
  const maximum = rows.reduce((currentMaximum, row) => {
    const match = String(row.invoice_no || '').match(/^INV-(\d+)$/i);
    const number = match ? Number(match[1]) : 0;
    return Number.isFinite(number) ? Math.max(currentMaximum, number) : currentMaximum;
  }, 0);
  return `${INVOICE_SERIES_PREFIX}${String(maximum + 1).padStart(4, '0')}`;
}

function createInvoiceItems(items, invoiceId, firstId) {
  return items.map((item, index) => ({
    id: firstId + index,
    invoice_id: invoiceId,
    description: item.description || item.item_name || '',
    product_id: item.productId ?? item.product_id ?? null,
    sku: item.sku || null,
    barcode: item.barcode || null,
    discount_percent: Number(item.discountPercent ?? item.discount_percent) || 0,
    list_rate: Number(item.originalRate ?? item.listRate) || 0,
    quantity: Number(item.quantity || 0),
    unit_price: Number(item.baseRate ?? item.rate ?? item.price ?? 0),
    rate: Number(item.baseRate ?? item.rate ?? item.price ?? 0),
    per: item.per || item.uom || 'Nos',
    total_sqft: item.totalSqft === '' || item.totalSqft === undefined
      ? null
      : Number(item.totalSqft),
    total: calculateInvoiceItemAmount(item),
  }));
}

export async function saveInvoiceLocally(invoiceData, items, options = {}) {
  try {
    const freight = Number.parseFloat(invoiceData.freight) || 0;
    const invoiceDate = toStoredInvoiceDate(invoiceData.invoiceDate);
    if (!invoiceDate) {
      throw new Error('Enter a valid invoice date in DD/MM/YYYY format.');
    }

    const calculated = calculateInvoiceReportTotals({
      items,
      freight,
      client_gstin: invoiceData.clientGstin,
      gst_rate: invoiceData.gstRate,
    });
    const enteredInvoiceNo = String(invoiceData.invoiceNo || '').trim();
    const requestedStatus = String(invoiceData.status || 'Pending').trim();
    const requestedAmountPaid = invoiceData.amountPaid ?? invoiceData.amount_paid;
    const amountPaid = Math.min(
      calculated.grandTotal,
      Math.max(
        0,
        Number(requestedAmountPaid ?? (
          requestedStatus.toLowerCase() === 'paid' ? calculated.grandTotal : 0
        )) || 0
      )
    );
    const status = calculated.grandTotal > 0 && amountPaid >= calculated.grandTotal
      ? 'Paid'
      : amountPaid > 0
        ? 'Partially Paid'
        : requestedStatus;

    const result = await localData.atomic(database => {
      const invoiceNo = enteredInvoiceNo
        ? (
            enteredInvoiceNo.toUpperCase().startsWith(INVOICE_SERIES_PREFIX)
              ? enteredInvoiceNo
              : `${INVOICE_SERIES_PREFIX}${enteredInvoiceNo}`
          )
        : nextInvoiceNumber(database.invoices);
      if (database.invoices.some(invoice =>
        String(invoice.invoice_no || '').trim().toLowerCase() === invoiceNo.toLowerCase()
      )) {
        throw new Error(`Invoice number already exists: ${invoiceNo}`);
      }

      const stockChanges = options.stockChanges || [];
      const aggregatedStockChanges = new Map();
      stockChanges.forEach(change => {
        const key = String(change.productId);
        aggregatedStockChanges.set(
          key,
          (aggregatedStockChanges.get(key) || 0) + Number(change.quantity || 0)
        );
      });

      const updatedProducts = database.products.map(product => {
        const quantity = aggregatedStockChanges.get(String(product.id));
        if (!quantity) return product;
        const stock = Number(product.stock ?? product.quantity ?? 0);
        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > stock) {
          throw new Error(`${product.product || 'A product'} has only ${stock} in stock.`);
        }
        return {
          ...product,
          stock: stock - quantity,
          updated_at: new Date().toISOString(),
        };
      });
      for (const productId of aggregatedStockChanges.keys()) {
        if (!database.products.some(product => String(product.id) === productId)) {
          throw new Error('A product in this sale is no longer in the catalog.');
        }
      }

      const invoiceId = nextNumericId(database.invoices);
      const createdAt = new Date().toISOString();
      const invoice = {
        id: invoiceId,
        invoice_no: invoiceNo,
        date: invoiceDate,
        client_id: invoiceData.clientId ?? invoiceData.client_id ?? null,
        client_name: invoiceData.clientName || invoiceData.client_name || '',
        client_address: invoiceData.clientAddress || invoiceData.client_address || '',
        client_email: invoiceData.clientEmail || invoiceData.client_email || '',
        client_gstin: invoiceData.clientGstin || invoiceData.client_gstin || '',
        po_no: invoiceData.poNo || invoiceData.po_no || '',
        po_date: invoiceData.poDate || invoiceData.po_date || '',
        purchase_order_id: invoiceData.purchaseOrderId ?? invoiceData.purchase_order_id ?? null,
        quotation_id: invoiceData.quotationId ?? invoiceData.quotation_id ?? null,
        freight,
        amount: calculated.grandTotal,
        grand_total: calculated.grandTotal,
        amount_paid: amountPaid,
        payment_method: invoiceData.paymentMethod || invoiceData.payment_method || '',
        status,
        gst_rate: invoiceData.gstRate === undefined ? null : Number(invoiceData.gstRate),
        subtotal: calculated.subtotal,
        cgst: calculated.cgst,
        sgst: calculated.sgst,
        igst: calculated.igst,
        created_at: createdAt,
        updated_at: createdAt,
      };
      const invoiceItems = createInvoiceItems(
        items,
        invoiceId,
        nextNumericId(database.invoice_items)
      );
      const purchaseOrderId = invoiceData.purchaseOrderId ?? invoiceData.purchase_order_id;
      if (purchaseOrderId !== undefined && purchaseOrderId !== null) {
        const purchaseOrder = database.purchase_orders.find(order =>
          String(order.id) === String(purchaseOrderId)
        );
        if (!purchaseOrder || purchaseOrder.party_type === 'supplier') {
          throw new Error('The selected customer purchase order is no longer available.');
        }
        if (purchaseOrder.invoice_id) {
          throw new Error('An invoice has already been created for this purchase order.');
        }
        purchaseOrder.invoice_id = invoiceId;
        purchaseOrder.updated_at = createdAt;
      }

      const quotationId = invoiceData.quotationId ?? invoiceData.quotation_id;
      if (quotationId !== undefined && quotationId !== null) {
        const quotation = database.quotations.find(record =>
          String(record.id) === String(quotationId)
        );
        if (!quotation) {
          throw new Error('The selected quotation is no longer available.');
        }
        if (quotation.invoice_id) {
          throw new Error('An invoice has already been created for this quotation.');
        }
        quotation.invoice_id = invoiceId;
        quotation.status = 'Invoiced';
        quotation.updated_at = createdAt;
      }

      database.invoices.push(invoice);
      database.invoice_items.push(...invoiceItems);
      database.products = updatedProducts;
      if (amountPaid > 0) {
        database.payments.push({
          id: nextNumericId(database.payments),
          invoice_id: invoiceId,
          amount: amountPaid,
          method: invoice.payment_method,
          reference: invoiceData.paymentReference || '',
          paid_at: invoiceData.paymentDate || createdAt,
          created_at: createdAt,
          updated_at: createdAt,
        });
      }
      return { invoiceNo, invoiceId };
    });

    if (result.error) {
      throw new Error(result.error.message);
    }
    return {
      success: true,
      invoiceNo: result.data.invoiceNo,
      invoiceId: result.data.invoiceId,
    };
  } catch (error) {
    console.error('Failed to save invoice locally:', error.message);
    alert(`Invoice Save Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}
