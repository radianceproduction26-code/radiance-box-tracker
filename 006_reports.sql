-- 006 Phase 5: reports. Adds read-only views and functions only. No table or data is changed.
-- Apply in the Supabase SQL editor, or with: supabase db push
--
-- Idea: every box has a history in box_events (CREATED, RECEIVED, DISPATCHED, ...). Replaying that history
-- tells us what the stock was on ANY past day, not just now. Everything below is built on `box_moves`.

-- 1. box_moves: one row per change of state of a box, with its effect on
--    FG stock (boxes received in the store) and on "packed, not yet in FG" (printed, not yet scanned in).
--      CREATED -> packed (WIP)      OPENING / RECEIVED / SLIP_VOIDED -> in FG
--      DISPATCHED -> gone           VOIDED -> gone
create or replace view public.box_moves with (security_invoker = true) as
with ev as (
  select e.id, e.box_id, e.event, e.at as ts, e.note, e.by_user, e.device,
         b.part_no, b.part_name, b.qty,
         case e.event
           when 'CREATED' then 'WIP' when 'OPENING' then 'FG' when 'RECEIVED' then 'FG'
           when 'DISPATCHED' then 'OUT' when 'VOIDED' then 'VOID' when 'SLIP_VOIDED' then 'FG'
         end as st
    from public.box_events e
    join public.boxes b on b.box_id = e.box_id
   where e.event in ('CREATED', 'OPENING', 'RECEIVED', 'DISPATCHED', 'VOIDED', 'SLIP_VOIDED')
), tr as (
  select ev.*, coalesce(lag(st) over (partition by box_id order by ts, id), 'NONE') as prev_st from ev
)
select id, box_id, event, ts as at, (ts at time zone 'Asia/Kolkata')::date as day,
       part_no, part_name, qty, note, by_user, device,
       ((case when st = 'FG' then qty else 0 end) - (case when prev_st = 'FG' then qty else 0 end))::bigint as fg_delta,
       ((case when st = 'WIP' then qty else 0 end) - (case when prev_st = 'WIP' then qty else 0 end))::bigint as wip_delta,
       ((st = 'FG')::int - (prev_st = 'FG')::int) as fg_box_delta,
       ((st = 'WIP')::int - (prev_st = 'WIP')::int) as wip_box_delta
  from tr;

-- 2. stock_ledger(from, to): per part per day (days with movement only):
--    FG opening, assembly out, FG inward, dispatched, other (+/-), FG closing, packed-not-in-FG closing.
--    other = opening stock added, slip voids (boxes back in FG), boxes voided while in FG.
--    Check: fg_open + in_qty + other_qty - disp_qty = fg_close.
create or replace function public.stock_ledger(p_from date, p_to date)
returns table (day date, part_no text, part_name text,
               fg_open bigint, out_qty bigint, in_qty bigint, disp_qty bigint, other_qty bigint, fg_close bigint, wip_close bigint,
               out_boxes integer, in_boxes integer, disp_boxes integer)
language sql stable security invoker set search_path = '' as $$
  with d as (
    select m.day, m.part_no, max(m.part_name) as part_name,
           coalesce(sum(m.qty) filter (where m.event = 'CREATED'), 0)::bigint as out_q,
           coalesce(sum(m.qty) filter (where m.event = 'RECEIVED'), 0)::bigint as in_q,
           coalesce(sum(m.qty) filter (where m.event = 'DISPATCHED'), 0)::bigint as disp_q,
           (count(*) filter (where m.event = 'CREATED'))::integer as out_b,
           (count(*) filter (where m.event = 'RECEIVED'))::integer as in_b,
           (count(*) filter (where m.event = 'DISPATCHED'))::integer as disp_b,
           sum(m.fg_delta)::bigint as fg_d, sum(m.wip_delta)::bigint as wip_d
      from public.box_moves m
     where m.day <= p_to
     group by m.day, m.part_no
  ), r as (
    select d.*,
           (sum(d.fg_d) over (partition by d.part_no order by d.day))::bigint as fg_c,
           (sum(d.wip_d) over (partition by d.part_no order by d.day))::bigint as wip_c
      from d
  )
  select r.day, r.part_no, r.part_name,
         r.fg_c - r.fg_d, r.out_q, r.in_q, r.disp_q, r.fg_d - r.in_q + r.disp_q, r.fg_c, r.wip_c,
         r.out_b, r.in_b, r.disp_b
    from r
   where r.day between p_from and p_to
   order by r.day, r.part_no;
$$;

-- 3. stock_as_on(day): FG stock and packed-not-in-FG, per part, at the END of that day (India date).
--    Handy for month-end and audits: stock_as_on('2026-10-31').
create or replace function public.stock_as_on(p_day date)
returns table (part_no text, part_name text, fg_qty bigint, fg_boxes integer, wip_qty bigint, wip_boxes integer)
language sql stable security invoker set search_path = '' as $$
  select m.part_no, max(m.part_name),
         coalesce(sum(m.fg_delta), 0)::bigint, coalesce(sum(m.fg_box_delta), 0)::integer,
         coalesce(sum(m.wip_delta), 0)::bigint, coalesce(sum(m.wip_box_delta), 0)::integer
    from public.box_moves m
   where m.day <= p_day
   group by m.part_no
  having sum(m.fg_delta) <> 0 or sum(m.wip_delta) <> 0 or sum(m.fg_box_delta) <> 0 or sum(m.wip_box_delta) <> 0
   order by m.part_no;
$$;

-- 4. box_trace: the full history of every box (who, when, which phone/PC, note or reason). Used for
--    "Box history" and for the list of voids. Names show for admin only (profiles are private to admin).
create or replace view public.box_trace with (security_invoker = true) as
select e.id, e.box_id, e.event, e.at, (e.at at time zone 'Asia/Kolkata')::date as day,
       e.note, e.device, p.full_name as by_name,
       b.part_no, b.part_name, b.qty
  from public.box_events e
  join public.boxes b on b.box_id = e.box_id
  left join public.profiles p on p.user_id = e.by_user;

-- 5. Only signed-in users may call the functions (the views are protected by the existing row rules).
revoke all on function public.stock_ledger(date, date) from public, anon;
revoke all on function public.stock_as_on(date) from public, anon;
grant execute on function public.stock_ledger(date, date) to authenticated;
grant execute on function public.stock_as_on(date) to authenticated;
revoke all on public.box_moves from anon;
revoke all on public.box_trace from anon;
