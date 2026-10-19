-- Receipt finder: attach receipts to company card charges automatically (19 Oct 2026)
-- A receipt (from finance@, Sophie's inbox or Slack) is matched to the card charge it paid for,
-- and if the receipt already has a PO, that PO is linked to the charge too.

alter table haus.po_receipts add column if not exists bank_txn_id uuid;
alter table haus.po_receipts add column if not exists source_url text;
create index if not exists po_receipts_bank_txn_idx on haus.po_receipts (bank_txn_id);

-- What the receipt finder has already looked for, so it doesn't search the same charge every run
create table if not exists haus.po_receipt_hunt (
  txn_id uuid primary key,
  last_searched timestamptz not null default now(),
  tries int not null default 1,
  found boolean not null default false,
  note text
);
alter table haus.po_receipt_hunt enable row level security;
drop policy if exists prh_read on haus.po_receipt_hunt;
create policy prh_read on haus.po_receipt_hunt for select to authenticated using (haus.can_see_money());
grant select on haus.po_receipt_hunt to authenticated;

-- first meaningful word of a merchant name ("Xero Custom Connections" -> "xero", "The Nici" -> "nici")
create or replace function haus.merchant_key(p text) returns text
language sql immutable set search_path = '' as $$
  select (select w from regexp_split_to_table(lower(regexp_replace(coalesce(p,''), '[^A-Za-z0-9 ]', ' ', 'g')), '\s+') with ordinality t(w, i)
          where length(w) >= 3 and w not in ('the','www','com','ltd','limited','inc','llc','pbc','plc','co','uk','payment','paypal')
          order by i limit 1)
$$;

create or replace function haus.merchant_matches(a text, b text) returns boolean
language sql immutable set search_path = 'haus', 'extensions' as $$
  select coalesce(a,'') <> '' and coalesce(b,'') <> '' and (
    extensions.similarity(lower(a), lower(b)) >= 0.3
    or position(haus.merchant_key(a) in lower(b)) > 0
    or position(haus.merchant_key(b) in lower(a)) > 0)
$$;

-- Link one PO to a card charge (no permission check: only called by the matcher)
create or replace function haus.po_auto_link_card(p_po uuid, p_txn uuid, p_why text) returns boolean
language plpgsql security definer set search_path = 'haus', 'public' as $$
declare t record;
begin
  if exists (select 1 from haus.purchase_orders where bank_txn_id = p_txn) then return false; end if;
  select * into t from haus.po_card_txns where id = p_txn;
  if not found then return false; end if;
  update haus.purchase_orders set bank_txn_id = p_txn,
    card = coalesce(card, case when t.source = 'capital_on_tap' then 'Capital on Tap' else 'Revolut' end),
    ordered_by = coalesce(ordered_by, t.initiated_by),
    status = case when status = 'raised' then 'ordered' else status end,
    ordered_at = coalesce(ordered_at, t.txn_date),
    edit_log = edit_log || haus.po_log('Card charge linked automatically', jsonb_build_object('date', t.txn_date, 'merchant', t.merchant, 'amount', t.amount, 'ccy', t.ccy, 'how', p_why))
  where id = p_po and bank_txn_id is null and status <> 'cancelled';
  return found;
end $$;

-- Match one receipt to the card charge it paid for. Only links when exactly one charge fits
-- (same amount and currency, close date, merchant name matches) and that charge has no other receipt.
create or replace function haus.po_card_match(p_receipt uuid) returns uuid
language plpgsql security definer set search_path = 'haus', 'public', 'extensions' as $$
declare r haus.po_receipts; hit uuid; n int; d date;
begin
  select * into r from haus.po_receipts where id = p_receipt;
  if r.id is null or r.dismissed then return null; end if;
  if r.bank_txn_id is null then
    if r.total is null or r.total <= 0 then return null; end if;
    d := coalesce(r.receipt_date, (r.received_at at time zone 'Europe/London')::date, (r.created_at at time zone 'Europe/London')::date);
    select count(*), min(c.id::text)::uuid into n, hit from haus.po_card_txns c
    where c.txn_date between d - 3 and d + 7
      and ((upper(c.ccy) = upper(coalesce(r.ccy,'GBP')) and abs(c.amount - r.total) <= 0.01)
           or (upper(coalesce(r.ccy,'GBP')) = 'GBP' and c.amount_gbp is not null and abs(c.amount_gbp - r.total) <= 0.01))
      and haus.merchant_matches(c.merchant, coalesce(r.merchant, split_part(coalesce(r.sender_email,''), '@', 2)))
      and not exists (select 1 from haus.po_receipts x where x.bank_txn_id = c.id and x.id <> r.id)
      and not exists (select 1 from haus.purchase_orders o where o.bank_txn_id = c.id and o.id is distinct from r.po_id);
    if n <> 1 then return null; end if;
    update haus.po_receipts set bank_txn_id = hit where id = r.id and bank_txn_id is null;
    insert into haus.po_receipt_hunt (txn_id, found, note) values (hit, true, 'Receipt matched: ' || coalesce(r.subject, r.merchant, ''))
      on conflict (txn_id) do update set found = true, last_searched = now(), note = excluded.note;
    r.bank_txn_id := hit;
  end if;
  -- the receipt already sits on a PO: put that PO on the same card charge
  if r.po_id is not null then
    perform haus.po_auto_link_card(r.po_id, r.bank_txn_id, 'receipt');
  end if;
  return r.bank_txn_id;
end $$;

-- Run the matcher over every recent receipt (cron backstop: card charges arrive hourly, receipts any time)
create or replace function haus.po_card_match_all() returns int
language plpgsql security definer set search_path = 'haus', 'public' as $$
declare r record; n int := 0;
begin
  for r in select id from haus.po_receipts
           where not dismissed and created_at > now() - interval '120 days'
             and (bank_txn_id is null or (po_id is not null and not exists (select 1 from haus.purchase_orders o where o.id = po_receipts.po_id and o.bank_txn_id is not null)))
  loop
    if haus.po_card_match(r.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function haus.po_receipts_card_trg() returns trigger
language plpgsql security definer set search_path = 'haus', 'public' as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  perform haus.po_card_match(new.id);
  return new;
end $$;
drop trigger if exists po_receipts_card_match on haus.po_receipts;
create trigger po_receipts_card_match after insert or update of total, ccy, merchant, receipt_date, po_id on haus.po_receipts
  for each row execute function haus.po_receipts_card_trg();

-- Raising a PO from a card charge, or linking one, brings any receipt already found for it
create or replace function haus.po_take_card_receipts(p_po uuid, p_txn uuid) returns void
language plpgsql security definer set search_path = 'haus', 'public' as $$
declare r record;
begin
  for r in select id from haus.po_receipts where bank_txn_id = p_txn and po_id is null and not dismissed loop
    perform haus.po_apply_receipt(r.id, p_po, 'card', 'Receipt finder');
  end loop;
end $$;

create or replace function public.haus_po_from_card(p_txn_id uuid, p_supplier text, p_description text, p_project_id uuid, p_event_label text, p_manager text, p_note text, p_category text)
 returns table(id uuid, po_number text)
 language plpgsql security definer set search_path to 'haus', 'public'
as $function$
declare r record;
begin
  if nullif(trim(p_category),'') is null then raise exception 'pick a category (it decides where it goes in Xero)'; end if;
  select * into r from public.haus_po_from_card(p_txn_id, p_supplier, p_description, p_project_id, p_event_label, p_manager, p_note) limit 1;
  update haus.purchase_orders po set category = trim(p_category), xero_account_code = haus.po_default_account(trim(p_category)) where po.id = r.id;
  perform haus.po_take_card_receipts(r.id, p_txn_id);
  return query select r.id, r.po_number;
end $function$;

create or replace function public.haus_po_link_card(p_id uuid, p_txn_id uuid)
 returns void language plpgsql security definer set search_path to 'haus', 'public'
as $function$
declare v_date date; v_merchant text; v_amount numeric; v_ccy text;
begin
  if not haus.can_see_money() then raise exception 'not allowed'; end if;
  if p_txn_id is not null then
    select txn_date, merchant, amount, ccy into v_date, v_merchant, v_amount, v_ccy from haus.po_card_txns where id = p_txn_id;
    if not found then raise exception 'card charge not found'; end if;
    if exists (select 1 from haus.purchase_orders where bank_txn_id = p_txn_id and id <> p_id) then raise exception 'that charge is already on another PO'; end if;
  end if;
  update haus.purchase_orders set bank_txn_id = p_txn_id,
    status = case when p_txn_id is not null and status = 'raised' then 'ordered' else status end,
    ordered_at = case when p_txn_id is not null then coalesce(ordered_at, v_date) else ordered_at end,
    edit_log = edit_log || haus.po_log(case when p_txn_id is null then 'Card charge unlinked' else 'Card charge linked' end,
      case when p_txn_id is null then '{}'::jsonb else jsonb_build_object('date', v_date, 'merchant', v_merchant, 'amount', v_amount, 'ccy', v_ccy) end)
  where id = p_id;
  if not found then raise exception 'PO not found'; end if;
  if p_txn_id is not null then perform haus.po_take_card_receipts(p_id, p_txn_id); end if;
end $function$;

-- Slack receipts are not emails: keep them away from the Gmail Apps Script's file queue
create or replace function public.haus_receipt_jobs(p_token text)
 returns table(id uuid, email_message_id text)
 language plpgsql security definer set search_path to 'haus', 'public'
as $function$
begin
  if p_token is null or not exists (select 1 from haus.integration_tokens t where t.name = 'gmail-apps-script' and t.token = p_token) then
    raise exception 'not allowed';
  end if;
  perform haus.heartbeat('apps-script-v6');
  return query select r.id, r.email_message_id from haus.po_receipts r
    where r.file_state = 'pending' and not r.dismissed and r.email_message_id not like 'slack:%' order by r.created_at limit 10;
end $function$;

-- Board views: card charges carry their receipt, receipts carry their charge
create or replace view public.haus_po_card_spend with (security_invoker = true) as
 select c.id, c.source, c.account, c.txn_date, c.txn_type, c.merchant, c.description, c.amount, c.ccy, c.amount_gbp, c.initiated_by, c.project_id,
    rc.id as rcpt_id, rc.email_message_id as rcpt_message_id, rc.subject as rcpt_subject, rc.file_state as rcpt_file_state,
    rc.source_url as rcpt_source_url, rc.total as rcpt_total, rc.ccy as rcpt_ccy,
    h.last_searched as hunt_at, h.tries as hunt_tries
   from haus.po_card_txns c
   left join lateral (select r.* from haus.po_receipts r where r.bank_txn_id = c.id and not r.dismissed order by r.created_at desc limit 1) rc on true
   left join haus.po_receipt_hunt h on h.txn_id = c.id
  where c.txn_date >= haus.po_start()
    and not exists (select 1 from haus.purchase_orders o where o.bank_txn_id = c.id)
    and not exists (select 1 from haus.po_card_skip s where s.txn_id = c.id);

create or replace view public.haus_po_receipts with (security_invoker = true) as
 select r.id, r.email_message_id, r.sender_email, r.subject, r.merchant, r.total, r.ccy, r.receipt_date, r.po_ref, r.description,
    r.received_at, r.po_id, po.po_number, r.match_method, r.matched_by, r.matched_at, r.dismissed, r.dismissed_by,
    r.file_state, r.file_name, r.file_error, r.note, r.created_at, r.bank_txn_id, r.source_url
   from haus.po_receipts r
   left join haus.purchase_orders po on po.id = r.po_id;

grant select on public.haus_po_card_spend, public.haus_po_receipts to authenticated;

-- every 10 minutes, after the hourly Revolut sync brings new card charges in
select cron.unschedule('haus-po-card-match') where exists (select 1 from cron.job where jobname = 'haus-po-card-match');
select cron.schedule('haus-po-card-match', '*/10 * * * *', $$select haus.po_card_match_all()$$);
