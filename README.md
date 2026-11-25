# iCanBill

This is an MVP of the iCanBill billing app. Supabase email/password authentication gates access, but invoices, clients, products, and settings are currently stored in the signed-in browser and are not synchronized to other devices.

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

Invoices, clients, products, and workspace settings are stored in this browser. Saved invoice PDFs are stored in browser IndexedDB. Clearing this site's browser storage removes the local demo data. There is no subscription or payment gateway in this MVP, and billing data is not yet persisted in Supabase.

Purchase-order extraction uses the authenticated Supabase Edge Function in `supabase/functions/extract-purchase-order`. Configure `GEMINI_API_KEY` as a Supabase Edge Function secret; users do not enter or store a Gemini key in their browser.

Deploy the function with the Supabase CLI after linking this project, and set the Gemini key as a project secret (Supabase Dashboard → Edge Functions → Secrets):

```sh
npx supabase link --project-ref ekpwirjqylynzhrrslyx
npx supabase functions deploy extract-purchase-order
```

Do not put the Gemini key in `.env.local` or share it in chat. The deployed function requires a signed-in user JWT.

## Supabase authentication

The app is gated by Supabase email/password authentication. Browser configuration is stored in `.env.local`:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-browser-safe-publishable-key
```

Apply `supabase/migrations/20261126000000_multi_tenant_foundation.sql` from the Supabase SQL Editor to create organizations, memberships, profiles, tenant tables, and row-level security policies. This is the database foundation; the existing billing screens still use browser storage until their data adapter is migrated.
