-- Schéma initial FuelPrice Control. Prix en FCFA entiers.
create extension if not exists pgcrypto;

create table tenants (
  id                        text primary key,           -- ex. "afriquia", utilisé dans les topics MQTT
  name                      text not null,
  confirm_pct               numeric(5,2) not null default 5,
  block_pct                 numeric(5,2) not null default 15,
  require_double_validation boolean not null default false,
  price_min                 integer not null default 500,
  price_max                 integer not null default 1500,
  created_at                timestamptz not null default now()
);

create table stations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      text not null references tenants(id),
  code           text not null,                          -- ex. "CI-ABJ-012"
  name           text not null,
  city           text,
  fuels          text[] not null,                        -- ex. {SP,GO}
  gateway_id     text not null unique,                   -- ex. "gw-0007"
  gateway_secret text not null,                          -- clé HMAC du boîtier (à déplacer dans un coffre-fort de clés)
  cmd_seq        bigint not null default 0,              -- dernier seq émis vers ce boîtier
  created_at     timestamptz not null default now(),
  unique (tenant_id, code)
);

-- Prix confirmés par le boîtier (relus sur le totem), pas les prix demandés.
create table station_prices (
  station_id    uuid not null references stations(id) on delete cascade,
  fuel          text not null,
  price         integer not null check (price > 0),
  source_cmd_id text,
  updated_at    timestamptz not null default now(),
  primary key (station_id, fuel)
);

create table gateway_status (
  gateway_id   text primary key references stations(gateway_id) on delete cascade,
  online       boolean not null,
  last_seen_at timestamptz not null,
  last_seq     bigint,
  reported     jsonb not null default '{}'
);

create table price_changes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references tenants(id),
  items        jsonb not null,              -- [{fuel, price}]
  station_ids  uuid[] not null,
  apply_at     timestamptz,                 -- null : dès réception
  status       text not null,               -- pending_approval | dispatched | cancelled
  comment      text,
  created_by   text not null,
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table commands (
  id              uuid primary key default gen_random_uuid(),
  cmd_id          text not null unique,
  price_change_id uuid not null references price_changes(id),
  station_id      uuid not null references stations(id),
  seq             bigint not null,
  payload         jsonb not null,           -- commande signée, renvoyée telle quelle lors des relances
  status          text not null,            -- sent | received | scheduled | totem_applied | applied | partially_applied | rejected | expired | superseded | failed | unconfirmed
  status_detail   text,
  attempts        integer not null default 1,
  last_sent_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index commands_station_idx on commands(station_id, created_at desc);
create index commands_open_idx on commands(status) where status in ('sent','received','scheduled','totem_applied');

create table command_events (
  id         bigserial primary key,
  command_id uuid not null references commands(id) on delete cascade,
  status     text not null,
  payload    jsonb,
  at         timestamptz not null default now()
);

create table alerts (
  id          bigserial primary key,
  tenant_id   text not null references tenants(id),
  station_id  uuid references stations(id),
  command_id  uuid references commands(id),
  kind        text not null,               -- partially_applied | failed | rejected | unconfirmed | gateway_offline
  message     text not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index alerts_open_idx on alerts(tenant_id) where resolved_at is null;

-- Journal d'audit : qui a fait quoi, quand.
create table audit_log (
  id        bigserial primary key,
  tenant_id text,
  actor     text not null,
  action    text not null,
  details   jsonb,
  at        timestamptz not null default now()
);
