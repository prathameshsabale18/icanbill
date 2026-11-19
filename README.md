# iCanBill

This is a local-first version of the existing billing app for testing. It opens directly without a sign-in screen. Invoices, clients, products, and settings are stored in this browser and are not synchronized to other devices.

## Workspace modes

Choose **Retail Mode** or **Business Mode** in Settings. Both modes use the same local product catalog, invoices, clients, PDF generator, reports, and billing logic. Switching modes does not clear or separate data.

- Retail Mode provides barcode/manual product lookup, bill discounts, invoice checkout, and stock tracking. USB barcode scanners that type a code and submit Enter are supported.
- Business Mode provides customer/order workflows, invoice generation, and the existing AI purchase-order extraction flow. The separate Purchase Orders screen is currently removed.
- Common dashboard, clients, billing, payments, and reporting screens remain available in both modes.

Retail discounts are applied to line prices before the existing GST calculation. Checkout records an invoice and its line items, stores its PDF, then deducts stock.

## Run locally

```sh
npm install
npm run dev
```

## Demo data

Invoices, clients, products, and workspace settings are stored in this browser. Saved invoice PDFs are stored in browser IndexedDB. Clearing this site's browser storage removes the local demo data. There is no user authentication, subscription, or payment gateway in this MVP.

AI extraction is still available when a Gemini API key is supplied. Purchase orders are sent to Google's Gemini service only when that feature is used.
