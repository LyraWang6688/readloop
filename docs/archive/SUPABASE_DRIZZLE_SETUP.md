# Supabase PostgreSQL + Drizzle Setup

This project uses Supabase only as a hosted PostgreSQL database. Data access still goes through Next.js API routes and Drizzle ORM.

## 1. Create a Supabase Project

1. Create a project in Supabase.
2. Open `Project Settings -> Database`.
3. Copy a PostgreSQL connection string.

Use the Direct connection string for local Drizzle migrations when possible. If your network cannot use Direct connection, use Session pooler. Avoid Transaction pooler for migrations.

## 2. Configure Environment Variables

Create or update `.env.local`:

```bash
DATABASE_URL=postgresql://postgres.your_project_ref:your_password@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=require
```

Never commit `.env.local`. It contains your database password and is ignored by Git.

## 3. Apply Drizzle Migrations

For an empty Supabase database, apply the existing migrations:

```bash
pnpm db:migrate
```

If `drizzle-kit migrate` reports success but no tables appear, check whether
your shell has an old `DATABASE_URL` exported. This config intentionally lets
`.env.local` override shell and `.env` values for Drizzle commands.

For quick development sync against an empty database, you can also use:

```bash
pnpm db:push
```

Prefer migrations once the schema is shared or deployed.

## 4. Verify Tables

In Supabase Table Editor or DBeaver, confirm these tables exist in the `public` schema:

- `health_check`
- `knowledge_points`
- `knowledge_point_events`
- `practice_sessions`
- `practice_answers`

## 5. Validate the Product Flow

1. Start the app with `pnpm dev`.
2. Import or paste an article.
3. Translate one paragraph and run AI diagnosis.
4. Click the knowledge-base button.
5. Confirm the new row appears in Supabase `knowledge_points`.
6. Save the same point again and confirm the existing row is updated instead of duplicated.

## Notes

- Do not install or use `@supabase/supabase-js` for this path.
- Keep user data access behind the existing Next.js API routes.
- Add Supabase Auth and RLS later only when the product needs real multi-user accounts.
