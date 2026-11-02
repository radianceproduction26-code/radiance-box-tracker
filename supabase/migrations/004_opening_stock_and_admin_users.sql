-- Applied to project ozrrmyrapsjngvrycnhl on 2026-10-31.
-- 001 (tables, security), 002 (box functions) and 003 (report views) are recorded in the Supabase project:
-- Dashboard > Database > Migrations. Export them into this folder with `supabase db pull`.

-- One-time opening FG stock upload (admin only) -------------------------------------------
create or replace function public.add_opening_stock(p_rows jsonb, p_device text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  r jsonb;
  v_part text; v_name text; v_std integer; v_n integer; v_loose integer; v_lot text; v_date date;
  v_pp text; v_tray text; i integer;
  v_boxes integer := 0; v_qty bigint := 0; v_parts integer := 0; v_row integer := 0;
begin
  perform private.require_role('admin');
  perform pg_advisory_xact_lock(7001);
  if exists (select 1 from public.settings where key = 'opening_stock_done') then
    raise exception 'Opening stock was already uploaded on %', (select value from public.settings where key = 'opening_stock_done');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No rows to upload';
  end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Too many rows (max 2000)'; end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_row := v_row + 1;
    v_part := private.clean_part(r->>'part_no');
    v_name := upper(btrim(coalesce(r->>'part_name', '')));
    v_std := nullif(btrim(coalesce(r->>'std_qty', '')), '')::integer;
    v_n := coalesce(nullif(btrim(coalesce(r->>'n_boxes', '')), '')::integer, 0);
    v_loose := coalesce(nullif(btrim(coalesce(r->>'loose_qty', '')), '')::integer, 0);
    v_lot := upper(btrim(coalesce(r->>'lot', '')));
    v_date := coalesce(nullif(btrim(coalesce(r->>'date', '')), '')::date, (now() at time zone 'Asia/Kolkata')::date);

    if v_part = '' then raise exception 'Row %: part no is missing', v_row; end if;
    if v_n < 0 or v_loose < 0 then raise exception 'Row % (%): quantities cannot be negative', v_row, v_part; end if;
    if v_n = 0 and v_loose = 0 then raise exception 'Row % (%): no boxes and no loose qty', v_row, v_part; end if;
    if v_n > 0 and (v_std is null or v_std <= 0) then raise exception 'Row % (%): qty per box is needed', v_row, v_part; end if;
    if v_n > 5000 then raise exception 'Row % (%): too many boxes (max 5000)', v_row, v_part; end if;

    select po.pp_box_code, po.tray_no into v_pp, v_tray
      from public.packing_options po where po.part_no = v_part and po.std_qty = v_std;
    v_pp := coalesce(v_pp, ''); v_tray := coalesce(v_tray, '');

    insert into public.parts (part_no, name, std_qty) values (v_part, v_name, v_std)
    on conflict (part_no) do update
      set name = case when excluded.name <> '' then excluded.name else public.parts.name end,
          std_qty = coalesce(excluded.std_qty, public.parts.std_qty);
    v_parts := v_parts + 1;

    for i in 1..v_n loop
      perform private.insert_box(v_part, v_name, v_std, 'FG-RECEIVED', 'OPENING', '', v_lot, v_date, v_pp, v_tray, v_user, p_device);
      v_boxes := v_boxes + 1; v_qty := v_qty + v_std;
    end loop;
    if v_loose > 0 then
      perform private.insert_box(v_part, v_name, v_loose, 'FG-RECEIVED', 'OPENING', '', v_lot, v_date, v_pp, v_tray, v_user, p_device);
      v_boxes := v_boxes + 1; v_qty := v_qty + v_loose;
    end if;
  end loop;

  insert into public.settings (key, value)
  values ('opening_stock_done', to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'));
  return jsonb_build_object('ok', true, 'boxes', v_boxes, 'qty', v_qty, 'rows', v_row);
end;
$$;

-- Admin: list every login with its profile (so roles can be assigned in the web app) ---------
create or replace function public.admin_list_users()
returns table (user_id uuid, email text, full_name text, role text, active boolean, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_role('admin');
  return query
    select u.id, u.email::text, p.full_name, p.role, p.active, u.last_sign_in_at
    from auth.users u left join public.profiles p on p.user_id = u.id
    order by u.created_at;
end;
$$;

revoke execute on function public.add_opening_stock(jsonb, text) from public, anon;
revoke execute on function public.admin_list_users() from public, anon;
grant execute on function public.add_opening_stock(jsonb, text) to authenticated;
grant execute on function public.admin_list_users() to authenticated;
