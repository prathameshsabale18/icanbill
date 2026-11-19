import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const TEAL = rgb(0, 0.4, 0.37);
const DARK = rgb(0.13, 0.18, 0.25);
const MUTED = rgb(0.4, 0.47, 0.55);
const BORDER = rgb(0.82, 0.87, 0.89);
const PALE = rgb(0.94, 0.97, 0.97);
const WHITE = rgb(1, 1, 1);
const OUTPUT_DIR = path.resolve('public', 'templates');

function drawText(page, text, x, y, font, size = 8, color = DARK) {
  page.drawText(text, { x, y, font, size, color });
}

function drawLine(page, x1, y1, x2, y2, color = BORDER, thickness = 0.6) {
  page.drawLine({
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    color,
    thickness,
  });
}

function drawInvoiceTemplate(page, regular, bold, { title, copy, printReady, challan }) {
  const left = 32;
  const right = PAGE_WIDTH - 32;

  page.drawRectangle({
    x: left,
    y: 30,
    width: right - left,
    height: PAGE_HEIGHT - 60,
    borderColor: BORDER,
    borderWidth: 0.8,
  });

  if (!printReady) {
    page.drawRectangle({
      x: left,
      y: 746,
      width: right - left,
      height: 66,
      color: PALE,
    });
    page.drawRectangle({
      x: left,
      y: 746,
      width: 4,
      height: 66,
      color: TEAL,
    });
    drawText(page, 'Your Business Name', 47, 786, bold, 16, TEAL);
    drawText(
      page,
      'Business address · Contact details · Tax / registration ID',
      47,
      768,
      regular,
      8,
      MUTED
    );
    drawText(page, title, 405, 786, bold, 12, DARK);
    drawText(page, copy, 405, 768, regular, 8, MUTED);
  } else {
    drawText(page, title, 38, 786, bold, 13, DARK);
    drawText(page, copy, 38, 768, regular, 8, MUTED);
  }

  drawLine(page, left, 738, right, 738, TEAL, 1);

  drawText(page, 'BILL TO', 39, 681, bold, 7, TEAL);
  drawText(page, 'Customer name and address', 39, 662, regular, 7, MUTED);
  drawText(page, 'Tax / registration ID', 397, 655, regular, 7, MUTED);
  drawText(page, 'State / region', 39, 617, regular, 7, MUTED);
  drawText(page, 'State code', 205, 617, regular, 7, MUTED);
  drawText(page, 'P.O. No.', 397, 638, regular, 7, MUTED);
  drawText(page, 'P.O. Date', 469, 638, regular, 7, MUTED);
  drawText(page, 'Vendor code', 397, 620, regular, 7, MUTED);

  page.drawRectangle({
    x: 386,
    y: 600,
    width: 167,
    height: 116,
    borderColor: BORDER,
    borderWidth: 0.5,
  });
  drawText(page, 'DOCUMENT NO.', 398, 700, bold, 6.5, MUTED);
  drawText(page, 'DATE', 493, 700, bold, 6.5, MUTED);
  drawLine(page, 481, 675, 481, 713, BORDER, 0.5);

  const tableTop = 570;
  const tableBottom = 340;
  const columns = [39, 72, 283, 353, 394, 435, 477, 553];
  page.drawRectangle({
    x: left,
    y: tableTop,
    width: right - left,
    height: 24,
    color: PALE,
  });
  drawLine(page, left, tableTop, right, tableTop, BORDER, 0.7);
  drawLine(page, left, tableTop - 24, right, tableTop - 24, BORDER, 0.7);
  drawLine(page, left, tableBottom, right, tableBottom, BORDER, 0.7);

  [
    ['#', 48],
    ['DESCRIPTION', 78],
    ['TAX CODE', 290],
    ['UNIT', 362],
    ['QTY', 399],
    ['RATE', 440],
    ['AMOUNT', 492],
  ].forEach(([label, x]) => drawText(page, label, x, 578, bold, 6.5, TEAL));

  columns.slice(1, -1).forEach(x =>
    drawLine(page, x, tableBottom, x, tableTop, BORDER, 0.45)
  );
  for (let row = 1; row <= 8; row += 1) {
    const y = tableTop - 24 - row * 25.75;
    drawLine(page, left, y, right, y, BORDER, 0.4);
  }

  drawText(page, 'AMOUNT IN WORDS', 39, 310, bold, 7, TEAL);
  drawLine(page, 39, 285, 365, 285, BORDER, 0.5);
  drawText(page, 'Assessable value', 395, 307, regular, 8, MUTED);
  drawText(page, 'Freight', 395, 289, regular, 8, MUTED);
  drawText(page, 'Subtotal', 395, 260, bold, 8, DARK);
  if (!challan) {
    drawText(page, 'CGST', 395, 239, regular, 8, MUTED);
    drawText(page, 'SGST', 395, 215, regular, 8, MUTED);
    drawText(page, 'IGST', 395, 191, regular, 8, MUTED);
  }

  page.drawRectangle({
    x: 395,
    y: challan ? 220 : 150,
    width: 158,
    height: 35,
    color: TEAL,
  });
  drawText(page, 'TOTAL', 405, challan ? 229 : 159, bold, 9, WHITE);

  drawText(page, 'Receiver signature', 39, 91, regular, 7, MUTED);
  drawText(page, 'For Your Business', 411, 91, bold, 8, DARK);
  drawLine(page, 39, 112, 190, 112, BORDER, 0.6);
  drawLine(page, 411, 112, 553, 112, BORDER, 0.6);
  drawText(page, copy, 39, 50, regular, 7, MUTED);
  drawText(page, 'Generated with Billing Workspace', 382, 50, regular, 7, MUTED);
}

async function createTemplate(name, options) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  drawInvoiceTemplate(page, regular, bold, options);
  await writeFile(
    path.join(OUTPUT_DIR, name),
    await document.save()
  );
}

async function generateTemplates() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  await Promise.all([
    createTemplate('invoice-master.pdf', {
      title: 'INVOICE',
      copy: 'Customer copy',
      printReady: false,
      challan: false,
    }),
    createTemplate('invoice-master-print.pdf', {
      title: 'INVOICE',
      copy: 'Customer copy',
      printReady: true,
      challan: false,
    }),
    createTemplate('invoice-office-copy.pdf', {
      title: 'INVOICE',
      copy: 'Office copy',
      printReady: false,
      challan: false,
    }),
    createTemplate('delivery-challan.pdf', {
      title: 'DELIVERY CHALLAN',
      copy: 'Recipient copy',
      printReady: false,
      challan: true,
    }),
  ]);
}

generateTemplates().catch(error => {
  console.error('Failed to generate generic invoice templates:', error);
  process.exitCode = 1;
});
