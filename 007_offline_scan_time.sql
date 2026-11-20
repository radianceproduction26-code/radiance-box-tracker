-- 007 Phase 6: offline scanning.
-- A scan made while the phone has no signal is kept on the phone and sent later. It must be dated when the box was REALLY
-- scanned (so "stock on a date", the Day summary and the ledger are right), not when the phone got its signal back.
-- receive_box gets one new optional argument, p_scanned_at. Old calls (3 arguments) work exactly as before.
-- The time is believed only if it is not in the future and not older than 7 days, and a box can never be received before its
-- label was printed; otherwise the server uses its own clock (a wrong phone clock cannot rewrite history).
-- Apply in the Supabase SQL editor, or with: supabase db push

drop function if exists public.receive_box(text, text, text);

create function public.receive_box(p_box_id text, p_rack text default null, p_device text default null, p_scanned_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_id text := upper(btrim(coalesce(p_box_id, '')));
  v_rack text := nullif(btrim(coalesce(p_rack, '')), '');
  v_user uuid := auth.uid();
  v_at timestamptz := now();
  v_row public.boxes;
  v_cur public.boxes;
begin
  perform private.require_role('store', 'fg', 'admin');
  if p_scanned_at is not null and p_scanned_at <= now() and p_scanned_at >= now() - interval '7 days' then
    v_at := p_scanned_at;
  end if;
  update public.boxes b
     set status = 'FG-RECEIVED', fg_at = greatest(v_at, b.created_at), fg_by = v_user, rack = v_rack
   where b.box_id = v_id and b.status = 'WIP-PACKED'
  returning b.* into v_row;
  if found then
    insert into public.box_events (box_id, event, at, by_user, device, note) values (v_id, 'RECEIVED', v_row.fg_at, v_user, p_device, v_rack);
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

revoke all on function public.receive_box(text, text, text, timestamptz) from public, anon;
grant execute on function public.receive_box(text, text, text, timestamptz) to authenticated;

notify pgrst, 'reload schema';
