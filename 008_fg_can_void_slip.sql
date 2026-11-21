-- 008: the FG role can now void a packing slip (it was admin only).
-- The ONLY change in this function is the role list on the require_role line: ('admin') -> ('admin', 'fg').
-- A reason is still required, the boxes go back to FG stock, every box gets a SLIP_VOIDED event with the user who did it, and the slip stays on record.
create or replace function public.void_slip(p_slip_no text, p_reason text, p_device text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_slip text := upper(btrim(coalesce(p_slip_no, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_user uuid := auth.uid();
  v_s public.slips;
  v_ids text[];
  v_n integer;
  v_q bigint;
begin
  perform private.require_role('admin', 'fg');
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
