-- Google Drive connection for the single owner-managed Drive account.
-- Refresh tokens are AES-256-GCM encrypted by the backend before they reach this table.
create table if not exists public.google_drive_connections (
  id text primary key check (id = 'primary'),
  email text not null default '',
  refresh_token_enc text not null,
  scopes text not null default '',
  connected_at timestamptz not null default now()
);
alter table public.google_drive_connections enable row level security;
revoke all on table public.google_drive_connections from anon, authenticated;
