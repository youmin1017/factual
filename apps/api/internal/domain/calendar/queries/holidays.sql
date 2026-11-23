-- name: ListDays :many
-- The imported days between two dates (inclusive).
select date, is_off, note from holidays
 where date between sqlc.arg(from_date)::date and sqlc.arg(to_date)::date
 order by date;

-- name: ListYears :many
select y.year, y.source_url, y.days, y.days_off, y.imported_at, u.display_name as imported_by
  from holiday_years y
  left join users u on u.id = y.imported_by
 order by y.year;

-- name: CoveredYears :many
select year from holiday_years
 where year between sqlc.arg(from_year)::integer and sqlc.arg(to_year)::integer;

-- name: DeleteYearDays :exec
delete from holidays
 where date >= make_date(sqlc.arg(year)::integer, 1, 1)
   and date < make_date(sqlc.arg(year)::integer + 1, 1, 1);

-- name: InsertDays :exec
insert into holidays (date, is_off, note)
select unnest(sqlc.arg(dates)::date[]), unnest(sqlc.arg(offs)::boolean[]), unnest(sqlc.arg(notes)::text[]);

-- name: UpsertYear :exec
insert into holiday_years (year, source_url, days, days_off, imported_by)
values ($1, $2, $3, $4, $5)
on conflict (year) do update
   set source_url = excluded.source_url, days = excluded.days, days_off = excluded.days_off,
       imported_by = excluded.imported_by, imported_at = now();

-- name: DeleteYear :execrows
delete from holiday_years where year = $1;
