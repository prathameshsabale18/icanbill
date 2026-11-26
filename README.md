# iCanBill

This is iCanBill, a subscription-based billing app. Supabase provides authentication, subscription enforcement, tenant isolation, and cloud storage for workspace records and files.

## Workspace modes

Choose **Retail Mode** or **Business Mode** in Settings. Both modes use the same cloud product catalog, invoices, clients, PDF generator, reports, and billing logic. Switching modes does not clear or separate data.

- Retail Mode provides barcode/manual product lookup, bill discounts, invoice checkout, and stock tracking. USB barcode scanners that type a code and submit Enter are supported.
- Business Mode provides customer/order workflows, invoice generation, purchase-order management, and the existing AI purchase-order extraction flow.
- Common dashboard, clients, billing, payments, and reporting screens remain available in both modes.

Retail discounts are applied to line prices before the existing GST calculation. Checkout records an invoice and its line items, stores its PDF, then deducts stock.

## Run locally

```sh
npm install
npm run dev
```

## Subscriptions and account access

The initial subscription flow is manual: confirm payment, issue a one-time activation code, and send it to the customer's email address. The customer uses that code, their email, and a password to create an account. Each activation grants 30 days, starting when the account is created. Customers renew by paying again and redeeming a new code while signed in. Codes are restricted to the email address they were issued for.

After applying all migrations, issue a code from the Supabase SQL Editor as an administrator:

```sql
select public.issue_subscription_code('customer@example.com');
```

Send the returned code to that customer securely. Run the same command after each confirmed renewal payment. Do not expose this database function to customers or put service-role credentials in the browser.

The day-25 reminder is shown in the app when five days or fewer remain; no email reminder is sent. Each paid account can register up to two browser profiles, and multiple tabs in a profile are allowed. A third profile is blocked until the subscriber confirms replacing the least recently used registered profile. Accounts remain individual: new accounts require their own admin-issued paid activation code, and subscribers cannot add users. Browser profiles are the practical device identifier; two browsers on the same computer count separately, and a web app cannot reliably verify physical hardware.

## Cloud workspace data

Invoices, clients, products, settings, and other workspace records are stored in Supabase and are isolated by organization. Reads and atomic writes require an active subscription and active device session. Private invoice PDFs and purchase-order attachments are stored in Supabase Storage. Existing browser-local records and referenced files are copied to the first signed-in account when that cloud workspace is empty; if it already contains data, local records are left in the browser and are not merged automatically.

Purchase-order extraction uses the Supabase Edge Function in `supabase/functions/extract-purchase-order`. The function verifies the caller's signed-in session and active subscription before using Gemini, and falls back to lower-demand supported Gemini models when a model is temporarily overloaded. Configure `GEMINI_API_KEY` as a Supabase Edge Function secret; users do not enter or store a Gemini key in their browser.

Deploy the function with the Supabase CLI after linking this project, and set the Gemini key as a project secret (Supabase Dashboard → Edge Functions → Secrets):

```sh
npx supabase link --project-ref ubpoxtyesoxnzsfhcccf
npx supabase functions deploy extract-purchase-order
```

Do not put the Gemini key in `.env.local` or share it in chat. Keep JWT verification enabled when deploying the function.

## Supabase authentication

The app is gated by Supabase email/password authentication. Browser configuration is stored in `.env.local`:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-browser-safe-publishable-key
```

Apply the migrations in timestamp order from the Supabase SQL Editor (or with the Supabase CLI):

1. `supabase/migrations/20261126000000_multi_tenant_foundation.sql`
2. `supabase/migrations/20261126003000_subscription_and_remote_workspace.sql`
3. `supabase/migrations/20261126003100_pgcrypto_search_path.sql`
4. `supabase/migrations/20261126003200_single_active_auth_session.sql`
5. `supabase/migrations/20261126003300_two_registered_devices.sql`

The second migration creates the subscription/code tables, paid-account signup trigger, server-side workspace snapshot functions, storage buckets, and access policies. The third sets the `pgcrypto` search path for Supabase projects that keep the extension in the `extensions` schema. The fourth removes the single-tab restriction. The fifth applies the two-registered-browser-profile limit and its replacement flow. If Supabase email confirmation is enabled, customers must confirm their email before signing in. Apply all migrations in order before publishing the updated app.
