# Atelier Org — Setup Guide

A working org chart you and your team can edit live in the browser. Hosted free, no terminal required.

## What you'll set up

1. **Supabase** — the database that stores your charts (free, no card needed)
2. **GitHub** — holds the code (free)
3. **Vercel** — runs the website (free, no card needed)

Total time: about 30 minutes.

---

## Step 1 — Create the database (Supabase)

1. Go to **https://supabase.com** and click **Start your project**.
2. Sign up with GitHub or email.
3. Click **New project**.
   - Name: `atelier-org` (anything you like)
   - Database password: click the generate button, **save it somewhere** (you won't need it for daily use, but keep it)
   - Region: pick the one closest to you
4. Wait about 90 seconds while it provisions.

5. Once you're in the dashboard, on the left sidebar click **SQL Editor**, then **New query**.
6. Paste this exactly:

```sql
create table public.charts (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled chart',
  tree jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.charts enable row level security;

create policy "anyone can read" on public.charts for select using (true);
create policy "anyone can insert" on public.charts for insert with check (true);
create policy "anyone can update" on public.charts for update using (true);
create policy "anyone can delete" on public.charts for delete using (true);

alter publication supabase_realtime add table public.charts;
```

7. Click **Run** (bottom right). You should see "Success. No rows returned."

8. Now grab your keys. Left sidebar, click the **gear icon** (Project Settings), then **API**.
   - Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`) — keep this somewhere
   - Copy the **anon public** key (long string starting with `eyJ...`) — keep this somewhere

You'll paste both into Vercel in step 3.

---

## Step 2 — Put the code on GitHub

1. Go to **https://github.com** and sign up if you don't have an account.

2. Click the **+** in the top right, then **New repository**.
   - Repository name: `atelier-org`
   - Set it to **Private** (so only you can see the code)
   - Tick **Add a README file**
   - Click **Create repository**

3. On the repo page, click **Add file** → **Upload files**.

4. Open the folder I gave you. Drag every file and folder from inside it into the GitHub upload area. Make sure the folder structure is preserved — `src/`, `public/`, `package.json`, etc. should all appear at the top level of the repo.

5. Scroll down, click **Commit changes**.

---

## Step 3 — Deploy the site (Vercel)

1. Go to **https://vercel.com** and click **Sign up**. Choose **Continue with GitHub**.

2. On the dashboard, click **Add New** → **Project**.

3. You'll see a list of your GitHub repos. Find `atelier-org` and click **Import**.

4. **Important** — before clicking Deploy, expand **Environment Variables** and add these two:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | the Project URL you copied from Supabase |
   | `VITE_SUPABASE_ANON_KEY` | the anon public key you copied from Supabase |

   Click **Add** for each.

5. Click **Deploy**. Wait about 90 seconds.

6. You'll get a URL like `atelier-org-xyz123.vercel.app`. Open it. You should see the empty chart list.

7. Click **New chart**, give it a name, and you're in.

---

## Day to day

- **The URL is your app.** Bookmark it. Share it with colleagues. Anyone with the link can view and edit.
- **Everything saves automatically.** You'll see "All changes saved" under the chart name.
- **Multiple people editing at once works** — changes sync live across browsers.
- **To create another version of an org chart**, go back to the chart list and click the duplicate icon on any chart. Useful for "current state" vs "proposed v1" vs "proposed v2".

## A note on access

Anyone with the URL can view and edit. The URL is hard to guess but not secret. Don't share it more widely than you'd share a Google Doc set to "anyone with the link". If you ever need to lock things down later, the same Supabase project supports proper authentication — you'd just need to add a login screen.

## If something goes wrong

- **"Setup not finished" screen** → environment variables didn't save. In Vercel, go to your project → Settings → Environment Variables, double-check both are there, then go to Deployments and click the three-dot menu on the latest deployment → Redeploy.
- **"Database error"** → either the SQL didn't run, or the keys are wrong. Run the SQL again in Supabase, then double-check the URL and anon key in Vercel.
- **Changes aren't syncing between browsers** → make sure you ran the last line of the SQL (`alter publication supabase_realtime add table public.charts`). You can run just that line again if needed.

## Editing the code later

You don't need to. But if you want to: edit any file directly on github.com (pencil icon, top right of any file). Vercel auto-deploys every change in about 60 seconds. No terminal involved.
