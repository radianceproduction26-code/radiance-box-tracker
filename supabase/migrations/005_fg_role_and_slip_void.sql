-- 005 Phase 4: "fg" role (FG store: inward + outward on one login), void a packing slip, slip summary view.
-- Apply in the Supabase SQL editor, or with: supabase db push

-- 1. New role: fg = FG store person who both receives (inward) and dispatches (outward)
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['assembly','store','dispatch','fg','admin','viewer']));

alter table public.box_events drop constraint box_events_event_check;
alter table public.box_events add constraint box_events_event_check
  check (event = any (array['CREATED','OPENING','RECEIVED','DISPATCHED','VOIDED','REPRINTED','SLIP_VOIDED']));

-- 2. Slip void bookkeeping (the boxes go back to FG-RECEIVED, the slip stays on record)
alter table public.slips
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid,
  add column if not exists void_reason text,
  add column if not exists void_boxes integer,
  add column if not exists void_qty bigint;

-- 3. Existing functions: allow the fg role (bodies unchanged apart from the role list)
create or replace function public.receive_box(p_box_id text, p_rack text default null, p_device text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_id text := upper(btrim(coalesce(p_box_id, '')));
  v_rack text := nullif(btrim(coalesce(p_rack, '')), '');
  v_user uuid := auth.uid();
  v_row public.boxes;
  v_cur public.boxes;
begin
  perform private.require_role('store', 'fg', 'admin');
  update public.boxes b
     set status = 'FG-RECEIVED', fg_at = now(), fg_by = v_user, rack = v_rack
   where b.box_id = v_id and b.status = 'WIP-PACKED'
  returning b.* into v_row;
  if found then
    insert into public.box_events (box_id, event, by_user, device, note) values (v_id, 'RECEIVED', v_user, p_device, v_rack);
    return jsonb_build_object('ok', true,
      'msg', format('%s received · %s %s · %s pcs', v_id, v_row.part_no, v_row.part_name, v_row.qty),
      'box', jsonb_build_object('box_id', v_row.box_id, 'part_no', v_row.part_no, 'part_name', v_row.part_name,
                                'qty', v_row.qty, 'rack', v_row.rack, 'fg_at', v_row.fg_at));
  end if;
  select * into v_cur from public.boxes where box_id = v_id;
  if not found then
    return jsonb_build_object('ok', false, 'msg', v_id || ': not in register');
  end if;
  return jsonb_build_object('ok', false, 'msg', format('%s: already %s%s', v_id, v_cur.status,
    case v_cur.status
      when 'FG-RECEIVED' then ' on ' || to_char(v_cur.fg_at at time zone 'Asia/Kolkata', 'DD.MM HH24:MI')
      when 'DISPATCHED' then ' on slip ' || coalesce(v_cur.slip_no, '')
      else '' end));
end;
$function$;

create or replace function public.check_box_for_slip(p_box_id text, p_scanned text[] default '{}'::text[])
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_id text := upper(btrim(coalesce(p_box_id, '')));
  v_have text[] := coalesce(p_scanned, '{}');
  b public.boxes;
  v_old text;
begin
  perform private.require_role('dispatch', 'fg', 'admin');
  select * into b from public.boxes where box_id = v_id;
  if not found then
    return jsonb_build_object('ok', false, 'msg', v_id || ': not in register');
  end if;
  if v_id = any (v_have) then
    return jsonb_build_object('ok', false, 'msg', v_id || ': already scanned in this slip');
  end if;
  if b.status <> 'FG-RECEIVED' then
    return jsonb_build_object('ok', false, 'msg', v_id || ': ' || case b.status
      when 'WIP-PACKED' then 'not yet received in FG (do FG inward first)'
      when 'DISPATCHED' then 'already dispatched on slip ' || coalesce(b.slip_no, '')
      else 'voided' end);
  end if;
  select o.box_id into v_old from public.boxes o
   where o.part_no = b.part_no and o.status = 'FG-RECEIVED' and o.seq < b.seq and not (o.box_id = any (v_have))
   order by o.seq limit 1;
  return jsonb_build_object('ok', true, 'warn', v_old is not null,
    'msg', format('%s · %s · %s pcs', v_id, b.part_no, b.qty) ||
           case when v_old is not null then ' · FIFO note: older box ' || v_old || ' of this part is still in stock' else '' end,
    'box', jsonb_build_object('box_id', b.box_id, 'part_no', b.part_no, 'part_name', b.part_name, 'qty', b.qty));
end;
$function$;

create or replace function public.create_slip(p_box_ids text[], p_party text, p_location text default ''::text, p_transport text default ''::text,
  p_vehicle text default ''::text, p_lr_no text default ''::text, p_inv_no text default ''::text, p_disp_exe text default ''::text,
  p_driver_name text default ''::text, p_driver_mob text default ''::text, p_device text default null::text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_ids text[];
  v_raw integer;
  v_n integer;
  v_bad text[];
  v_party text := btrim(coalesce(p_party, ''));
  v_day text;
  v_cnt integer;
  v_slip text;
  v_qty bigint;
  v_user uuid := auth.uid();
begin
  perform private.require_role('dispatch', 'fg', 'admin');
  select count(*), array_agg(distinct upper(btrim(x))) into v_raw, v_ids
    from unnest(coalesce(p_box_ids, '{}')) x where btrim(x) <> '';
  v_n := coalesce(cardinality(v_ids), 0);
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'msg', 'No boxes to dispatch');
  end if;
  if v_raw <> v_n then
    return jsonb_build_object('ok', false, 'msg', 'The same box is listed twice');
  end if;
  if v_party = '' then
    return jsonb_build_object('ok', false, 'msg', 'Party name is required');
  end if;

  perform b.box_id from public.boxes b where b.box_id = any (v_ids) order by b.box_id for update;
  select array_agg(x order by x) into v_bad from unnest(v_ids) x
   where not exists (select 1 from public.boxes b where b.box_id = x and b.status = 'FG-RECEIVED');
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'msg', 'Some boxes are not available for dispatch: ' || array_to_string(v_bad, ', '),
                              'bad', to_jsonb(v_bad));
  end if;

  v_day := to_char(now() at time zone 'Asia/Kolkata', 'YYMMDD');
  insert into private.slip_counters as c (day, n) values (v_day, 1)
  on conflict (day) do update set n = c.n + 1
  returning c.n into v_cnt;
  v_slip := 'SL-' || v_day || '-' || case when v_cnt < 1000 then lpad(v_cnt::text, 3, '0') else v_cnt::text end;

  insert into public.slips (slip_no, party, location, transport, vehicle, lr_no, inv_no, disp_exe, driver_name, driver_mob, created_by)
  values (v_slip, v_party, btrim(coalesce(p_location, '')), btrim(coalesce(p_transport, '')), btrim(coalesce(p_vehicle, '')),
          btrim(coalesce(p_lr_no, '')), btrim(coalesce(p_inv_no, '')), btrim(coalesce(p_disp_exe, '')),
          btrim(coalesce(p_driver_name, '')), btrim(coalesce(p_driver_mob, '')), v_user);

  update public.boxes set status = 'DISPATCHED', slip_no = v_slip, out_at = now(), out_by = v_user
   where box_id = any (v_ids);
  insert into public.box_events (box_id, event, by_user, device, note)
  select x, 'DISPATCHED', v_user, p_device, v_slip from unnest(v_ids) x;

  insert into public.parties (name, location, transport, disp_exe, driver_name, driver_mob)
  values (v_party, btrim(coalesce(p_location, '')), btrim(coalesce(p_transport, '')), btrim(coalesce(p_disp_exe, '')),
          btrim(coalesce(p_driver_name, '')), btrim(coalesce(p_driver_mob, '')))
  on conflict (name) do update
    set location = excluded.location, transport = excluded.transport, disp_exe = excluded.disp_exe,
        driver_name = excluded.driver_name, driver_mob = excluded.driver_mob;

  select coalesce(sum(qty), 0) into v_qty from public.boxes where box_id = any (v_ids);
  return jsonb_build_object('ok', true, 'slip_no', v_slip, 'boxes', v_n, 'qty', v_qty);
end;
$function$;

-- parties are saved by whoever creates the slip
drop policy if exists parties_insert on public.parties;
drop policy if exists parties_update on public.parties;
create policy parties_insert on public.parties for insert to authenticated
  with check ((select private.my_role()) = any (array['admin','dispatch','fg']));
create policy parties_update on public.parties for update to authenticated
  using ((select private.my_role()) = any (array['admin','dispatch','fg']))
  with check ((select private.my_role()) = any (array['admin','dispatch','fg']));

-- 4. Void a slip (admin only): boxes return to FG-RECEIVED, the slip stays on record as VOIDED
create or replace function public.void_slip(p_slip_no text, p_reason text, p_device text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_slip text := upper(btrim(coalesce(p_slip_no, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_user uuid := auth.uid();
  v_s public.slips;
  v_ids text[];
  v_n integer;
  v_q bigint;
begin
  perform private.require_role('admin');
  if v_reason is null then
    return jsonb_build_object('ok', false, 'msg', 'A reason is required to void a slip');
  end if;
  select * into v_s from public.slips where slip_no = v_slip for update;
  if not found then
    return jsonb_build_object('ok', false, 'msg', v_slip || ': slip not found');
  end if;
  if v_s.voided_at is not null then
    return jsonb_build_object('ok', false, 'msg', v_slip || ': already voided on ' || to_char(v_s.voided_at at time zone 'Asia/Kolkata', 'DD.MM HH24:MI'));
  end if;
  perform 1 from public.boxes where slip_no = v_slip order by box_id for update;
  select array_agg(box_id order by box_id), count(*), coalesce(sum(qty), 0) into v_ids, v_n, v_q
    from public.boxes where slip_no = v_slip and status = 'DISPATCHED';
  update public.boxes set status = 'FG-RECEIVED', slip_no = null, out_at = null, out_by = null
   where slip_no = v_slip and status = 'DISPATCHED';
  insert into public.box_events (box_id, event, by_user, device, note)
  select x, 'SLIP_VOIDED', v_user, p_device, v_slip || ': ' || v_reason from unnest(coalesce(v_ids, '{}')) x;
  update public.slips set voided_at = now(), voided_by = v_user, void_reason = v_reason, void_boxes = v_n, void_qty = v_q
   where slip_no = v_slip;
  return jsonb_build_object('ok', true, 'msg', format('%s voided · %s boxes back in FG stock', v_slip, v_n), 'boxes', v_n, 'qty', v_q);
end;
$function$;

revoke execute on function public.void_slip(text, text, text) from public, anon;
grant execute on function public.void_slip(text, text, text) to authenticated;

-- 5. One row per slip with box count and quantity (for the Slips list)
create or replace view public.slip_summary with (security_invoker = true) as
select s.slip_no, s.created_at, s.party, s.location, s.transport, s.vehicle, s.lr_no, s.inv_no,
       s.disp_exe, s.driver_name, s.driver_mob, s.voided_at, s.void_reason,
       (case when s.voided_at is null then coalesce(b.n, 0) else coalesce(s.void_boxes, 0) end)::integer as boxes,
       (case when s.voided_at is null then coalesce(b.q, 0) else coalesce(s.void_qty, 0) end)::bigint as qty
  from public.slips s
  left join lateral (select count(*) as n, sum(x.qty) as q from public.boxes x where x.slip_no = s.slip_no) b on true;

revoke all on public.slip_summary from public, anon, authenticated;
grant select on public.slip_summary to authenticated;
