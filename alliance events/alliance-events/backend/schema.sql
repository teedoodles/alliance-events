-- Run in Supabase: SQL Editor > New query > paste > Run
create extension if not exists pgcrypto;

create table admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('super_admin','event_manager','checkin_staff')),
  created_at timestamptz not null default now()
);

create table events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category text not null default 'General',
  venue text,
  event_date date not null,
  start_time time, end_time time,
  reg_opens date, reg_deadline date,
  capacity int not null check (capacity > 0),
  status text not null default 'Upcoming' check (status in ('Upcoming','Active','Completed','Cancelled')),
  reg_open boolean not null default true,
  -- Validity: once this moment passes, the event is hidden from users and all registration is refused server-side.
  valid_until timestamptz not null,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  mobile text not null,
  organization text, department text,
  participant_type text not null default 'Student',
  photo_ref text,
  photo_consent boolean not null default false,
  created_at timestamptz not null default now()
);

create table registrations (
  id uuid primary key default gen_random_uuid(),
  reg_code text not null unique default ('AU' || upper(substr(encode(gen_random_bytes(4),'hex'),1,6))),
  participant_id uuid not null references participants(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  email_verified boolean not null default false,
  mobile_verified boolean not null default false,
  status text not null default 'Registered' check (status in ('Registered','Cancelled')),
  registered_at timestamptz not null default now(),
  checked_in_at timestamptz,
  checked_in_by uuid references admins(id) on delete set null,
  unique (participant_id, event_id)
);
create index on registrations (event_id, status);
create index on events (valid_until);
create index on registrations (registered_at);

create table otp_verifications (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email','mobile')),
  identifier text not null,
  otp_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);
create index on otp_verifications (identifier, created_at desc);

create view event_stats as
select e.*,
  (e.valid_until < now()) as expired,
  count(r.id) filter (where r.status <> 'Cancelled') as registered,
  count(r.id) filter (where r.status <> 'Cancelled' and r.email_verified and r.mobile_verified) as verified,
  count(r.id) filter (where r.checked_in_at is not null) as checked_in,
  count(r.id) filter (where r.status = 'Cancelled') as cancelled
from events e left join registrations r on r.event_id = e.id
group by e.id;

-- Atomic registration: locks the event row so capacity and duplicates can never be beaten by a race.
create or replace function register_for_event(
  p_event uuid, p_name text, p_email text, p_mobile text, p_org text, p_dept text,
  p_type text, p_photo text, p_consent boolean
) returns registrations language plpgsql security definer as $$
declare ev events; pid uuid; r registrations; cnt int;
begin
  select * into ev from events where id = p_event and not archived for update;  -- row lock serialises concurrent registrants
  if not found then raise exception 'EVENT_NOT_FOUND'; end if;
  if now() > ev.valid_until then raise exception 'EVENT_EXPIRED'; end if;
  if ev.status in ('Completed','Cancelled') or not ev.reg_open
     or (ev.reg_deadline is not null and current_date > ev.reg_deadline)
     or (ev.reg_opens is not null and current_date < ev.reg_opens) then
    raise exception 'REGISTRATION_CLOSED';
  end if;
  select count(*) into cnt from registrations where event_id = p_event and status <> 'Cancelled';
  if cnt >= ev.capacity then raise exception 'EVENT_FULL'; end if;
  if exists (select 1 from registrations x join participants p on p.id = x.participant_id
             where x.event_id = p_event and x.status <> 'Cancelled' and (p.email = p_email or p.mobile = p_mobile)) then
    raise exception 'DUPLICATE';
  end if;
  insert into participants (full_name, email, mobile, organization, department, participant_type, photo_ref, photo_consent)
  values (p_name, p_email, p_mobile, p_org, p_dept, p_type, p_photo, p_consent)
  on conflict (email) do update set full_name = excluded.full_name, mobile = excluded.mobile,
    organization = excluded.organization, department = excluded.department, participant_type = excluded.participant_type,
    photo_ref = coalesce(excluded.photo_ref, participants.photo_ref),
    photo_consent = participants.photo_consent or excluded.photo_consent
  returning id into pid;
  insert into registrations (participant_id, event_id, email_verified, mobile_verified)
  values (pid, p_event, true, true)
  on conflict (participant_id, event_id) do update
    set status = 'Registered', registered_at = now(), checked_in_at = null
    where registrations.status = 'Cancelled'
  returning * into r;
  if r.id is null then raise exception 'DUPLICATE'; end if;
  return r;
end $$;

-- Lock everything down: only the server (service role key) can touch data.
alter table admins enable row level security;
alter table events enable row level security;
alter table participants enable row level security;
alter table registrations enable row level security;
alter table otp_verifications enable row level security;
revoke all on admins, events, participants, registrations, otp_verifications, event_stats from anon, authenticated;
revoke execute on function register_for_event from public, anon, authenticated;

-- Photo storage: create a PRIVATE bucket named participant-photos (Storage > New bucket, public OFF).
