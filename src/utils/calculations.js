export function calculateItemAmount(item = {}) {
  const quantityValue =
    item.quantity ?? item.qty ?? item.quantity_value ?? '';
  const hasQuantity =
    String(quantityValue).trim() !== '' &&
    Number(quantityValue) > 0;
  const quantity = Number(quantityValue) || 0;
  const rate = Number(
    item.baseRate ?? item.rate ?? item.unit_price ?? item.price ?? 0
  ) || 0;
  const per = String(item.per ?? item.uom ?? '').toLowerCase();
  const description = String(item.description || '');
  const totalSqftValue = item.totalSqft ?? item.total_sqft ?? '';

  if (per === 'job' && !hasQuantity) {
    return rate;
  }

  if (
    per.includes('sqft') ||
    per.includes('sq.ft') ||
    /sq\.?\s*ft/i.test(description)
  ) {
    const manualTotalSqft = Number(totalSqftValue);

    if (String(totalSqftValue).trim() !== '' && manualTotalSqft > 0) {
      return manualTotalSqft * rate;
    }

    const dimensions = description.match(
      /(\d+(?:\.\d+)?)\s*(?:x|X|\*|\u00D7|\u2715|\u2716)\s*(\d+(?:\.\d+)?)/
    );

    if (dimensions) {
      return quantity * Number(dimensions[1]) * Number(dimensions[2]) * rate;
    }
  }

  return quantity * rate;
}

export function calculateTotals(items = [], clientGstin = '', freight = 0) {
  const parsedFreight = Number(freight) || 0;

  const updatedItems = items.map(item => {
    const amount = calculateItemAmount(item);
    return { ...item, lineAmount: amount };
  });

  // Calculate items subtotal
  const subtotal = updatedItems.reduce((acc, item) => acc + item.lineAmount, 0);

  // Assessable value including freight
  let assessableValue = subtotal + parsedFreight;

  const cgst = assessableValue * 0.09;
  const sgst = assessableValue * 0.09;
  const igst = 0;

  const totalTax = cgst + sgst + igst;
  const grandTotal = Math.round((assessableValue + totalTax) * 100) / 100;

  return {
    items: updatedItems,
    subtotal,
    freight: parsedFreight,
    assessableValue,
    cgst,
    sgst,
    igst,
    totalTax,
    grandTotal
  };
}
export function numberToWords(num) {
  const roundedNum = Math.round(Number(num) || 0);
  if (roundedNum === 0) return 'Zero';

  const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const inWords = (n) => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + a[n % 10] : ' ');
    if (n < 1000) return a[Math.floor(n / 100)] + 'Hundred ' + (n % 100 !== 0 ? 'and ' + inWords(n % 100) : '');
    return '';
  };

  if (roundedNum.toString().length > 9) return 'overflow';

  let n = ('000000000' + roundedNum).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);

  if (!n) return '';

  let str = '';
  str += (n[1] != 0) ? (inWords(Number(n[1])) + 'Crore ') : '';
  str += (n[2] != 0) ? (inWords(Number(n[2])) + 'Lakh ') : '';
  str += (n[3] != 0) ? (inWords(Number(n[3])) + 'Thousand ') : '';
  str += (n[4] != 0) ? (inWords(Number(n[4])) + 'Hundred ') : '';
  str += (n[5] != 0) ? ((str != '') ? 'and ' : '') + inWords(Number(n[5])) : '';

  return str.trim() + ' Only';
}

// Shared GST calculation for the separate New Invoice flow.
// Seller is registered in Maharashtra (state code 27); current invoice rate is 18%.
export function calculateGstBreakdown(
  assessableValue,
  clientStateCode,
  docType = 'TAX_INVOICE',
  gstRate = 18
) {
  const amount = Number(assessableValue) || 0;

  if (docType === 'DC_CHALLAN') {
    return {
      cgst: 0,
      sgst: 0,
      igst: 0,
      totalTax: 0,
      grandTotal: Math.round(amount * 100) / 100,
      validStateCode: true,
    };
  }

  const stateCode = String(clientStateCode ?? '').trim();
  if (!/^\d{2}$/.test(stateCode)) {
    return {
      cgst: 0,
      sgst: 0,
      igst: 0,
      totalTax: 0,
      grandTotal: Math.round(amount * 100) / 100,
      validStateCode: false,
    };
  }

  const rate = Number(gstRate);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error('GST rate must be a valid non-negative number.');
  }

  const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;

  if (stateCode === '27') {
    cgst = roundMoney(amount * rate / 200);
    sgst = roundMoney(amount * rate / 200);
  } else {
    igst = roundMoney(amount * rate / 100);
  }

  const totalTax = roundMoney(cgst + sgst + igst);
  return {
    cgst,
    sgst,
    igst,
    totalTax,
    grandTotal: roundMoney(amount + totalTax),
    validStateCode: true,
  };
}
