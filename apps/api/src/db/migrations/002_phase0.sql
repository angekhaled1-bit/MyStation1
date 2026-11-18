-- Phase 0 : stations sans boîtier. Le gérant reçoit la consigne par un lien,
-- change les prix lui-même et confirme avec des photos.

alter table stations add column mode text not null default 'gateway' check (mode in ('gateway', 'manual'));
alter table stations add column manager_name text;
alter table stations add column manager_phone text;
alter table stations alter column gateway_id drop not null;
alter table stations alter column gateway_secret drop not null;
alter table stations add constraint stations_gateway_required
  check (mode = 'manual' or (gateway_id is not null and gateway_secret is not null));

alter table commands add column channel text not null default 'mqtt' check (channel in ('mqtt', 'manual'));
-- Empreinte SHA-256 du jeton du lien envoyé au gérant (le jeton lui-même n'est jamais stocké).
alter table commands add column manual_token_hash text unique;
alter table commands add column opened_at timestamptz;
alter table commands add column confirmed_at timestamptz;
alter table commands add column confirmation jsonb;

create table command_photos (
  id         bigserial primary key,
  command_id uuid not null references commands(id) on delete cascade,
  kind       text not null check (kind in ('totem', 'pump')),
  path       text not null,
  mime       text not null,
  size       integer not null,
  created_at timestamptz not null default now()
);

-- Grille officielle des prix, validée par deux personnes.
create table official_grids (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references tenants(id),
  effective_at timestamptz not null,
  items        jsonb not null,               -- [{fuel, price}]
  reference    text,                         -- ex. numéro de l'arrêté ou du communiqué
  status       text not null,                -- pending_approval | validated | cancelled
  created_by   text not null,
  validated_by text,
  validated_at timestamptz,
  price_change_id uuid references price_changes(id),
  created_at   timestamptz not null default now()
);
create index official_grids_effective_idx on official_grids(tenant_id, effective_at desc) where status = 'validated';

alter table price_changes add column grid_id uuid references official_grids(id);

-- Journal des notifications envoyées aux gérants (SMS, WhatsApp…).
create table notifications (
  id         bigserial primary key,
  tenant_id  text not null references tenants(id),
  command_id uuid references commands(id) on delete cascade,
  channel    text not null,
  recipient  text not null,
  body       text not null,
  status     text not null,                  -- sent | failed
  error      text,
  created_at timestamptz not null default now()
);
