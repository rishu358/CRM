# Zoho CRM gap analysis: what Phase 2 should build first

Written 2026-10-26 for the owner. Research only: no application code was changed.

Zoho CRM is the reference product (CLAUDE.md section 14, rule 3). This file compares it with what our CRM
does today, so you can choose what Phase 2 builds first. It describes how Zoho behaves in my own words. It
copies no Zoho wording, design or icons, and it holds no data from anyone's Zoho account.

## 1. The short version

1. **Zoho's rupee prices match the figures we had.** Zoho's own page shows Standard ₹800, Professional ₹1,400,
   Enterprise ₹2,400 and Ultimate ₹2,600 per user per month when billed yearly. Nothing changed. New
   information: the month-to-month prices are higher (₹1,300, ₹2,100, ₹3,000, ₹3,200). Details are in section 4.
2. **Our MVP covers the core well, but not what a new customer expects in the first hour.** We have records,
   Kanban, lead conversion, import and export, roles, audit, search and a dashboard. We do not have list
   filters on screen, saved views, tags, a pipeline editor, merge, email, WhatsApp chat, web forms,
   automation, reports or quotes. Zoho has all of these. Most are in its cheapest paid plan or the free plan.
3. **The biggest gaps for a small Indian business are, in order:** filters and saved views, WhatsApp, a
   website lead form, quotes with GST, email, simple automation, then reports.
4. **Where we can win:** setup in 10 minutes (a goal, not yet proven), the security and data-rights work
   already built, WhatsApp and GST as everyday features instead of add-ons, and no feature locks on the
   cheapest plan if you choose that. Section 5 says which of these I could and could not check.
5. **I could not do the live look in your own Zoho account.** Claude in Chrome shows no connected browser
   (checked several times). See section 2. Nothing in this file comes from your account.

## 2. How this was researched, and what is missing

| Source                                                                                                  | Done?        | Notes                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zoho's public pricing page and its feature-by-edition page                                              | Yes          | Read in full as text in a browser. These are primary sources. The feature page says it was last updated 12 May 2026.                                                 |
| Zoho help pages and developer docs (workflow rules, Blueprint, forecasting, reports, WhatsApp, modules) | Partly       | Read through a summarising tool, not word for word. Good enough for "what does it do". Treat exact limits from these pages as unverified. The feature page is exact. |
| Bigin (Zoho's cheap small-business CRM) pricing                                                         | Partly       | Page shows US dollars only for me. No rupee price found. Rupee price is unverified.                                                                                  |
| Third-party review sites                                                                                | Yes, thin    | A few Capterra and Software Finder comments. Anecdotes, not facts. Marked unverified below.                                                                          |
| **Your own signed-in Zoho, read-only, through Claude in Chrome**                                        | **No**       | No Chrome browser is connected to Claude from this session, so I stopped that part as instructed. I did not try to sign in.                                          |
| Your nine earlier screenshots                                                                           | Not seen     | They were in another conversation.                                                                                                                                   |
| Our own app                                                                                             | Yes, by code | I read the spec, the routes, the API controllers and the screens. I did not run the app for this report, so "yes" means the code exists.                             |

**What the live look would have added** (still wanted): how Home and first-run onboarding feel, the Leads and
Contacts list filters, the Kanban and its stage prompts, Reports folders and the builder, the dashboard
component types, Forecasts, the Workflow Rules screen, email and WhatsApp channel settings, Marketplace and
the sample data. Everything in the table that is about how a screen _feels_ is therefore missing, and the
Zoho column is based on public documents only.

**To finish the live look,** either connect Claude in Chrome to this machine and sign in to Zoho yourself, or
re-share the nine screenshots. Then a short follow-up can add a "how it feels" column.

How "size to build" is judged: small is up to about a week, medium is one to three weeks, large is a month or
more. These are my rough guesses for one developer using Claude Code. They are unverified.

## 3. (a) Zoho areas compared with our app today

"Matters" is for a small Indian business with 2 to 50 users (high, medium, low). Evidence for "have it" is the
route, module or spec line. Zoho facts come from its feature page unless marked.

| Area                                            | What Zoho does                                                                                                                                                                                | Do we have it?                                                                                                                                                                                                                                        | Matters | Size                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------- |
| Leads, Contacts, Accounts, Deals                | The four core records, in every edition including Free.                                                                                                                                       | **Yes.** Pages `/leads`, `/contacts`, `/accounts`, `/deals`, each with a detail page.                                                                                                                                                                 | High    | Done                                   |
| Lead conversion                                 | A lead becomes contact, account and deal in one step (workflow action exists too).                                                                                                            | **Yes.** `POST /leads/:id/convert`, convert dialog, offers to link existing records (spec M4).                                                                                                                                                        | High    | Done                                   |
| List filters and saved views                    | Filters on any list, saved custom views (unlimited from Standard), Kanban for deals and activities.                                                                                           | **Partly.** The API accepts `filter` and `sort` (`packages/contracts/src/pagination.ts`) and lists have search and a column chooser. I found no filter screen. Saved-view tables exist in the database (`saved_views`) but there is no API or screen. | High    | Medium                                 |
| Deals pipeline and Kanban                       | Kanban, up to 5 pipelines on Standard, custom stages.                                                                                                                                         | **Partly.** Kanban with drag and drop is built (`deals-board.tsx`). `GET /pipelines` is the only pipeline route, so I found no way to add or edit pipelines or stages in the app.                                                                     | High    | Small                                  |
| Duplicates and merge                            | Find and merge in every edition; automatic de-duplicate from Professional.                                                                                                                    | **Partly.** Duplicate warning on create and convert (`duplicate-check`). No merge (spec lists it as P1).                                                                                                                                              | Medium  | Medium                                 |
| Tags                                            | Tags on records (5 per record on Standard).                                                                                                                                                   | **No.** Tag tables are in the spec; I found no tag module or screen.                                                                                                                                                                                  | Medium  | Small                                  |
| Bulk actions                                    | Mass update, delete, tag and email from a list.                                                                                                                                               | **Partly.** Bulk reassign owner exists (`POST /ownership/reassign`, reassign dialog). No bulk edit, tag or delete.                                                                                                                                    | Medium  | Small                                  |
| Activities, tasks, calls, meetings, reminders   | Tasks, calls, meetings, recurring activities, calendar booking, Google calendar sync.                                                                                                         | **Partly.** Tasks, calls, meetings, notes, "My Day" and an in-app bell exist (`/my-day`, `/activities`, `/notifications`). No email reminders, no calendar sync, no recurring tasks found.                                                            | High    | Medium                                 |
| Workflow rules (automation)                     | "When this happens, do that": triggers on create, edit, date or score; actions such as email, task, field update, webhook, convert. Free has 10 rules per module, Standard 30 (feature page). | **No.** The event queue (outbox) it would run on is built; there is no rule builder. Spec puts it in Phase 2.                                                                                                                                         | High    | Large                                  |
| Assignment rules (round-robin leads)            | Rules that route new leads to people. Standard and up.                                                                                                                                        | **No.** Owner is set by hand or by bulk reassign.                                                                                                                                                                                                     | High    | Small to medium                        |
| Web forms for lead capture                      | Embed a form on a website; it creates a lead and can reply automatically. All editions (1 form per module on Free).                                                                           | **No.**                                                                                                                                                                                                                                               | High    | Medium (needs spam and abuse controls) |
| Blueprint (guided stage process)                | Forces the same steps and required fields as a deal moves stage, with before, during and after checks. Professional and up.                                                                   | **No.** We do require a lost reason when a deal is lost (spec M5), which is a small part of it.                                                                                                                                                       | Medium  | Large                                  |
| Cadences (follow-up sequences)                  | A timed series of calls, emails and tasks per lead. Standard and up.                                                                                                                          | **No.**                                                                                                                                                                                                                                               | Medium  | Medium                                 |
| Email in the CRM                                | Connect a mailbox, send and see email on the record, templates, mass email (250 a day on Standard), email scheduling.                                                                         | **No.** We send only system emails (sign-in, invites). Spec says Gmail and Outlook sync is Phase 2.                                                                                                                                                   | High    | Large                                  |
| WhatsApp                                        | Business messaging channel: conversations on the record, approved message templates, automatic messages from workflows. Listed under all paid editions (feature page). Not on Free.           | **Barely.** A WhatsApp number field on contacts (`contact-detail.tsx`). No chat button, no messages. Owner's decision: start as a plain chat button.                                                                                                  | High    | Small (button), Large (Business API)   |
| Phone and call logging                          | Phone bridge to telephony providers; call logging.                                                                                                                                            | **No.** Calls can be logged by hand as an activity.                                                                                                                                                                                                   | Medium  | Medium                                 |
| Reports                                         | Many ready-made reports (Zoho's help page says over 40), custom reports (100 on Standard, unlimited on Professional), tabular, summary and matrix types, folders, scheduling.                 | **No.** Only the fixed dashboard and exports.                                                                                                                                                                                                         | High    | Large                                  |
| Dashboards and charts                           | Custom dashboards and many chart and KPI component types (feature page lists comparator, funnel, quadrant, target meter, cohort and more).                                                    | **Partly.** One fixed dashboard `/dashboard`: pipeline by stage, won this month, leads by source, overdue tasks, leaderboard. Not configurable.                                                                                                       | Medium  | Medium                                 |
| Sales forecasting                               | Forecasts by period with targets and quotas. 5 on Standard, 20 on Ultimate.                                                                                                                   | **No.** Spec puts forecasting in Phase 3.                                                                                                                                                                                                             | Medium  | Medium                                 |
| Products, price books, quotes, orders, invoices | Quotes, sales orders, invoices, purchase orders. Professional and up. Tax rates field also Professional and up.                                                                               | **No.** Spec lists quotes with GST and PDF, products and price books for Phase 2.                                                                                                                                                                     | High    | Large                                  |
| Multiple currencies                             | 5 active currencies on Standard.                                                                                                                                                              | **Partly.** Money is stored with a currency (`amount_minor`, `currency`). I did not confirm an exchange-rate screen.                                                                                                                                  | Low     | Small                                  |
| Custom fields, layouts, custom modules          | Custom fields (10 per module on Standard, 155 on Professional), page layouts from Professional, custom modules (10 on Standard).                                                              | **Partly.** Custom fields and picklists: yes (`/settings/fields`, spec M9 ticked). Layout sections are in the spec; I did not check them. Custom modules: no (spec Phase 3).                                                                          | Medium  | Layouts small, objects large           |
| Roles, field security, sharing                  | Profiles and roles (5 each on Standard), field-level security from Professional, sharing rules from Enterprise.                                                                               | **Yes.** Roles, own/team/all scope, field-level hidden/read/write, access explorer (`/settings/access`).                                                                                                                                              | High    | Done                                   |
| Audit log                                       | Audit logs from Standard.                                                                                                                                                                     | **Yes.** `/settings/audit-log`, exportable, hidden fields redacted.                                                                                                                                                                                   | Medium  | Done                                   |
| Privacy and data rights                         | GDPR settings in every edition.                                                                                                                                                               | **Yes.** Export and erase a person, consent tracking, recycle bin (`/settings/data-rights`, `/settings/recycle-bin`). DPDP-specific features at Zoho: unverified.                                                                                     | Medium  | Done                                   |
| Import and export                               | Import 1,000 rows per batch on Free, 20,000 on Standard, 200,000 on Ultimate. Export up to 200,000 records.                                                                                   | **Yes.** `/import`, exports from lists. Spec records 50,000 contacts imported in the background.                                                                                                                                                      | High    | Done                                   |
| Search                                          | Global search with a customisable layout.                                                                                                                                                     | **Yes.** `Ctrl+K` palette and list search, measured at 1M records (`docs/PERF.md`).                                                                                                                                                                   | Medium  | Done                                   |
| Files on records                                | Document library and file fields.                                                                                                                                                             | **Yes.** Attachments on any record (`attachments` module).                                                                                                                                                                                            | Medium  | Done                                   |
| First-run setup and sample data                 | Sample data on first run and a checklist on the home page (from your earlier screenshots, which I have not seen).                                                                             | **Yes.** `/setup`, setup checklist, removable sample data (ADR-0037). The 10-minute goal is not yet tested (spec M2 box unticked).                                                                                                                    | High    | Done                                   |
| Public API, API keys, webhooks                  | REST API with daily credits per edition; webhooks from Standard (1 per action, 25,000 calls a day).                                                                                           | **Partly.** We have a versioned REST API with an OpenAPI file (`docs/openapi.json`) but it is signed-in-user only. No API keys, no outgoing webhooks (the outbox is ready for them).                                                                  | Medium  | Medium                                 |
| Marketplace and integrations                    | Extensions marketplace (5 on Standard, 50 on Ultimate), Google, Microsoft, Slack, QuickBooks, Zoho's own apps.                                                                                | **No.**                                                                                                                                                                                                                                               | Low now | Large                                  |
| Mobile app                                      | Mobile app in every edition including Free.                                                                                                                                                   | **Partly.** Responsive web only. I found no installable-app (PWA) manifest.                                                                                                                                                                           | Medium  | Small (PWA), Large (native)            |
| AI assistant (Zia) and agents                   | Assistant, predictions, email and call summaries. Most from Professional or Enterprise.                                                                                                       | **No.** Spec puts AI in Phase 3.                                                                                                                                                                                                                      | Low now | Large                                  |
| Enterprise extras                               | Territories, approval processes, journeys, customer portals, sandboxes, CPQ. Mostly Enterprise and up.                                                                                        | **No.**                                                                                                                                                                                                                                               | Low     | Large each                             |

## 4. (b) Zoho's real rupee prices

**Source:** Zoho's own pricing page, https://www.zoho.com/crm/zohocrm-pricing.html, and its feature-by-edition
page, https://www.zoho.com/crm/complete-feature-list.html. **Read on 2026-10-26.** The feature page says it
was last updated 12 May 2026.

About the address: the India-style addresses I tried (`/in/crm/zohocrm-pricing.html` and `/in/crm/pricing/`)
return "page not found". The normal address showed rupees on its own in my browser. I do not know whether
Zoho chooses the currency by the visitor's location. That is unverified.

| Edition      | Billed yearly (per user, per month) | Billed month to month | Our figure   | Difference |
| ------------ | ----------------------------------- | --------------------- | ------------ | ---------- |
| Free         | ₹0, up to 3 users, "forever"        | n/a                   | not listed   | New        |
| Standard     | ₹800                                | ₹1,300                | about ₹800   | None       |
| Professional | ₹1,400                              | ₹2,100                | about ₹1,400 | None       |
| Enterprise   | ₹2,400                              | ₹3,000                | about ₹2,400 | None       |
| Ultimate     | ₹2,600                              | ₹3,200                | about ₹2,600 | None       |

- **Tax.** Zoho's page says only that local taxes (VAT, GST and so on) are added to these prices. It does not
  say 18 percent. The 18 percent is our own assumption for software services in India. Unverified on Zoho's side.
- **Other Zoho products on the same page.** CRM Plus (the bundle) shows ₹1,200 (Starter) and ₹2,900
  (Enterprise) per user per month. I could not tell whether those are the yearly or monthly figures, so treat them as unverified.
- **Extras Zoho charges on top** (feature page, rupees): 5 GB more file storage ₹275 a month; 100 MB more data
  storage ₹240 a month (₹120 above 200 users); a data backup ₹690 per request. Paid plans include a number of
  free API credits and then charge for more.
- **Free plan limits.** 3 users, 5,000 records, no custom reports, no custom fields, 1 deal pipeline (feature page).
- **Bigin, Zoho's small-business CRM,** shows US$7, US$12 and US$18 per user per month billed yearly
  (Express, Premier, Bigin 360) and a free single-user plan. No rupee price found. Unverified in rupees. Bigin is the product a small shop will compare us with, not only Zoho CRM.

**What this means for our price decision.** Parity with Zoho means about ₹800 to ₹2,600 per user per
month before GST. At parity, our Standard-priced plan needs to beat what Zoho gives at ₹800. Zoho's Standard
is limited in ways that matter (section 5), and ours is not limited yet.

## 5. (c) Where Zoho is weak and we could win

Each line says how sure I am.

| Opportunity                                                                                                                                                                                                                                                                 | How sure                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The cheapest paid plan is held back.** Standard allows 10 custom fields per module, no page layouts, no field-level security, no Blueprint, no validation rules, and a small mass-email limit (250 a day). We could give every plan fields, field-level access and roles. | **Verified** that Zoho's plan has these limits (feature page, 2026-10-26). Whether customers mind is unverified.                                                          |
| **Add-on charges.** More storage and backups cost extra. Reviewers on third-party sites say costs add up.                                                                                                                                                                   | Zoho's own charges: **verified**. "Customers complain" is **unverified** (a few anecdotes).                                                                               |
| **Hard to set up.** Reviewers describe a large system with a steep start. Our goal is first deal in 10 minutes.                                                                                                                                                             | Reviewer comments **unverified**. Our 10-minute goal is **not yet proven** (spec M2, unticked).                                                                           |
| **WhatsApp that just works.** Zoho's channel needs approved message templates, and business-started messages must be allowed by the customer. A plain chat button needs none of that.                                                                                       | Template rule: **verified in a Zoho help article through a summary**, but one claim (no promotional messages) came from an older community post, so it is **unverified**. |
| **GST in the quote.** Zoho's GST handling is clearly in its finance products (Books, Invoice, Billing). I found nothing that says Zoho CRM quotes carry GSTIN, HSN or SAC codes and CGST/SGST/IGST split.                                                                   | Absence only: **unverified**. Check in the live account before we claim this.                                                                                             |
| **Security you can show.** We have row-level tenant isolation proven by tests, MFA, an append-only audit log and a rebuilt-from-backup drill. A customer can read the evidence in this repository.                                                                          | **Verified for us.** What Zoho does here is **unverified**, and Zoho is likely strong too. Use as proof, not as an attack.                                                |
| **Indian data rules.** DPDP erasure and consent tools are built in, and data stays where we host it.                                                                                                                                                                        | Ours **verified in code**. Zoho has GDPR settings in every edition (**verified**). Whether Zoho CRM has an India data centre and DPDP tooling: **unverified**.            |
| **Speed.** Search at 1M records answers in about 0.1 to 0.3 seconds on our test.                                                                                                                                                                                            | Ours **measured** (`docs/PERF.md`, on our own test data). Zoho's speed: **unverified**.                                                                                   |

**What we should not claim:** we are not ahead on features. Zoho has far more. Our case is "simple, safe,
and WhatsApp and GST first", and we have to build the first-hour basics before that case is believable.

## 6. (d) Recommended Phase 2 order

Reasoning is one line each. This keeps the spec's Phase 2 ideas but moves the daily-use basics first,
because a trial user hits them in the first hour.

1. **Filters, saved views, tags, bulk edit, pipeline and stage editor, record merge.** Zoho gives these on every paid plan and a rep misses them on day one; most of the API already exists. _(Small to medium each.)_
2. **WhatsApp chat button on every record** (your decision: start plain). It is the favourite channel of our buyers and needs no Meta approval. _(Small.)_
3. **Website lead form plus lead assignment rules.** It feeds the CRM from the customer's own website and is on Zoho's free plan, so we cannot skip it. _(Medium.)_
4. **Products, quotes with GST, PDF.** This is how a deal turns into money, and a GST-correct quote is our best chance to beat Zoho where it is thin. Check Zoho's own quote first (section 7, question 6). _(Large.)_
5. **Email on the record: send and log first, two-way sync later.** Reps live in email; the first cut can be small and safe. _(Medium first cut, Large for full sync.)_
6. **Simple automation: trigger, condition, action.** Our event queue is ready; start with assign owner, create task, notify, send template message. _(Large.)_
7. **Reports and a configurable dashboard, then forecasts.** Owners want to see numbers their own way, but this is the most work and needs the data from steps 1 to 6. _(Large.)_
8. **API keys and outgoing webhooks.** Lets customers connect their own tools; the outbox is ready. _(Medium.)_
9. **Self-serve billing (Razorpay or Stripe).** Needed before anyone pays, so its place depends on when hosting starts (question 3). _(Medium.)_

Later, as in the spec: Blueprint-style guided stages, cadences, calendar sync, mobile app and PWA, custom
objects, AI, SSO, marketplace.

## 7. Questions only you can answer

1. **Can you connect Claude in Chrome and sign in to Zoho yourself, or re-share the nine screenshots,** so I can add the "how it feels" part?
2. **Which business type is first?** Jewellers, real estate, D2C or distributors need different things. Real estate wants forms, calls and WhatsApp early. Distributors want quotes and orders early. This can reorder section 6.
3. **When do you need to charge money?** Hosting is deferred. If the first customers are free pilots, billing can wait.
4. **WhatsApp after the chat button:** do you want approved template messages (needs a provider and Meta business checks, with per-message cost) or stop at the button for now?
5. **Email:** which mailbox do your first customers use: Gmail, Outlook or Zoho Mail? That sets which connection we build first.
6. **GST quotes:** do you need only GSTIN, HSN or SAC and the CGST/SGST/IGST split on a quote, or also government e-invoicing? The second is much bigger. I would also like to check Zoho's own quote in your account.
7. **Plan limits:** do we copy Zoho's habit of limiting fields, pipelines and records per plan, or price only by number of users? This decides how we use our plan switch (`packages/core/src/entitlements`).
8. **Free plan:** do we match Zoho's free 3 users, or something else?
9. **Languages:** do the first customers need Hindi or other Indian languages in the screens?
10. **Tally or Zoho Books:** do your buyers expect a link to their accounts software? I have not verified how much they care.

## 8. Sources

- Zoho CRM pricing: https://www.zoho.com/crm/zohocrm-pricing.html (read 2026-10-26)
- Zoho CRM features by edition: https://www.zoho.com/crm/complete-feature-list.html (read 2026-10-26, page dated 12 May 2026)
- Zoho CRM features overview: https://www.zoho.com/crm/features.html
- Zoho CRM WhatsApp page: https://www.zoho.com/crm/whatsapp.html
- Zoho workflow rules help: https://help.zoho.com/portal/kb/articles/configuring-workflow-rules
- Zoho Blueprint help: https://help.zoho.com/portal/en/kb/crm/process-management/blueprint/articles/execute-blueprint
- Zoho forecasting: https://www.zoho.com/crm/sales-force-automation/forecasting.html
- Zoho reports help: https://help.zoho.com/portal/en/kb/crm/analytics-and-dashboards/reports/articles/create-reports
- Zoho developer API, modules: https://www.zoho.com/crm/developer/docs/api/v8/modules-api.html
- Bigin pricing: https://www.bigin.com/pricing.html
- Reviews (anecdotes only): Capterra and Software Finder pages for Zoho CRM
- Our own: `docs/MVP_SPEC.md`, `apps/web/src/app`, `apps/api/src/modules`, `packages/contracts/src/pagination.ts`, `docs/HANDOVER.md`
