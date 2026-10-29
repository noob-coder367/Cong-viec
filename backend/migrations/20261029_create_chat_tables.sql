create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null default 'general' check (char_length(room_id) between 1 and 80),
  sender_name text not null check (char_length(trim(sender_name)) between 1 and 40),
  content text not null check (char_length(trim(content)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_room_created_idx on public.chat_messages (room_id, created_at desc);
alter table public.chat_messages enable row level security;
revoke all on public.chat_messages from anon, authenticated;

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  drive_file_id text not null,
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  web_view_link text not null,
  thumbnail_link text,
  created_at timestamptz not null default now()
);
create index if not exists chat_attachments_message_idx on public.chat_attachments (message_id);
alter table public.chat_attachments enable row level security;
revoke all on public.chat_attachments from anon, authenticated;
