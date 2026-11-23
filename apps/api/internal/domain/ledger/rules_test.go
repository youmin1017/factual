package ledger

import (
	"testing"
	"time"

	"factual/apps/api/internal/domain/ledger/internal/db"
)

func d(y int, m time.Month, dd int) time.Time { return time.Date(y, m, dd, 0, 0, 0, 0, time.UTC) }

func mustRule(t *testing.T, text string, start time.Time, shift db.HolidayShift, off func(time.Time) bool) rule {
	t.Helper()
	rr, err := parseRule(text, start)
	if err != nil {
		t.Fatalf("parseRule(%q): %v", text, err)
	}
	if off == nil {
		off = weekend
	}
	return rule{rr: rr, shift: shift, off: off}
}

func TestParseRuleRejects(t *testing.T) {
	for _, text := range []string{"", "FREQ=HOURLY", "FREQ=DAILY;BYHOUR=3", "nonsense", "FREQ=MONTHLY;BYMONTHDAY=40"} {
		if _, err := parseRule(text, d(2026, 11, 1)); err == nil {
			t.Errorf("parseRule(%q) accepted", text)
		}
	}
}

func TestShiftOffDaysOff(t *testing.T) {
	newYear := func(t time.Time) bool { return weekend(t) || t.Equal(d(2027, 1, 1)) }
	next := mustRule(t, "FREQ=MONTHLY;BYMONTHDAY=1", d(2026, 11, 1), db.HolidayShiftNextWorkday, newYear)
	got := next.between(d(2026, 11, 1), d(2027, 1, 31))
	want := []occurrence{
		{Nominal: d(2026, 11, 1), Date: d(2026, 11, 2)}, // Sunday
		{Nominal: d(2026, 12, 1), Date: d(2026, 12, 1)},
		{Nominal: d(2027, 1, 1), Date: d(2027, 1, 4)}, // a holiday, then the weekend
	}
	if len(got) != len(want) {
		t.Fatalf("between = %v, want %v", got, want)
	}
	for i := range want {
		if !got[i].Nominal.Equal(want[i].Nominal) || !got[i].Date.Equal(want[i].Date) {
			t.Errorf("occurrence %d = %v, want %v", i, got[i], want[i])
		}
	}

	// Moving back crosses into the previous month, and so does the month
	// the money is asked for.
	prev := mustRule(t, "FREQ=MONTHLY;BYMONTHDAY=1", d(2026, 10, 1), db.HolidayShiftPrevWorkday, nil)
	got = prev.between(d(2026, 10, 1), d(2026, 10, 31))
	if len(got) != 2 || !got[1].Date.Equal(d(2026, 10, 30)) {
		t.Fatalf("October = %v, want Oct 1 and Nov 1 moved to Oct 30", got)
	}
	in := targetInput{rule: prev, mode: db.BudgetModeFull, amount: 100}
	if s := monthShare(in, d(2026, 10, 1)); s != 200 {
		t.Errorf("October full = %d, want 200", s)
	}
	if s := monthShare(in, d(2026, 11, 1)); s != 0 {
		t.Errorf("November full = %d, want 0", s)
	}
}

func TestNextSkipsPostedAndSkipped(t *testing.T) {
	r := mustRule(t, "FREQ=MONTHLY;BYMONTHDAY=5", d(2026, 11, 5), db.HolidayShiftNone, nil)
	posted := map[time.Time]bool{d(2026, 11, 5): true}
	skipped := map[time.Time]bool{d(2026, 12, 5): true}
	o, ok := r.next(d(2026, 11, 1), posted, skipped)
	if !ok || !o.Nominal.Equal(d(2027, 1, 5)) {
		t.Fatalf("next = %v %v, want 2027-01-05", o, ok)
	}
	ended := mustRule(t, "FREQ=MONTHLY;BYMONTHDAY=5;COUNT=1", d(2026, 11, 5), db.HolidayShiftNone, nil)
	if _, ok := ended.next(d(2026, 11, 6), nil, nil); ok {
		t.Fatal("a rule with one occurrence has none after it")
	}
	if !r.isOccurrence(d(2027, 2, 5)) || r.isOccurrence(d(2027, 2, 6)) {
		t.Fatal("isOccurrence")
	}
}

func TestFullCountsEveryOccurrenceInTheMonth(t *testing.T) {
	weekly := mustRule(t, "FREQ=WEEKLY;BYDAY=MO", d(2026, 11, 1), db.HolidayShiftNone, nil)
	in := targetInput{rule: weekly, mode: db.BudgetModeFull, amount: 50, skipped: map[time.Time]bool{}}
	if s := monthShare(in, d(2026, 11, 1)); s != 250 { // Nov 2, 9, 16, 23, 30
		t.Errorf("five Mondays = %d, want 250", s)
	}
	in.skipped[d(2026, 11, 9)] = true
	if s := monthShare(in, d(2026, 11, 1)); s != 200 {
		t.Errorf("with one skipped = %d, want 200", s)
	}
	in.mode = db.BudgetModeNone
	if s := monthShare(in, d(2026, 11, 1)); s != 0 {
		t.Errorf("not budgeted = %d", s)
	}
}

func TestSpreadSavesUpBeforeEachOccurrence(t *testing.T) {
	yearly := mustRule(t, "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", d(2027, 3, 15), db.HolidayShiftNone, nil)
	in := targetInput{rule: yearly, mode: db.BudgetModeSpread, created: d(2026, 11, 10), amount: 1200}
	// The first one from the month the schedule was made: Nov..Mar.
	for m := d(2026, 11, 1); !m.After(d(2027, 3, 1)); m = m.AddDate(0, 1, 0) {
		if s := monthShare(in, m); s != 240 {
			t.Errorf("%s = %d, want 240", m.Format("2006-01"), s)
		}
	}
	if s := monthShare(in, d(2026, 10, 1)); s != 0 {
		t.Errorf("before the schedule = %d, want 0", s)
	}
	// Then twelve months each, the remainder in the month it is due.
	in.amount = 1000
	var sum int64
	for m := d(2027, 4, 1); !m.After(d(2028, 3, 1)); m = m.AddDate(0, 1, 0) {
		s := monthShare(in, m)
		want := int64(83)
		if m.Month() == time.March {
			want = 87
		}
		if s != want {
			t.Errorf("%s = %d, want %d", m.Format("2006-01"), s, want)
		}
		sum += s
	}
	if sum != 1000 {
		t.Errorf("a year adds up to %d, want 1000", sum)
	}

	// Monthly or more often, spreading is the same as full.
	monthly := mustRule(t, "FREQ=MONTHLY;BYMONTHDAY=5", d(2026, 1, 5), db.HolidayShiftNone, nil)
	spread := targetInput{rule: monthly, mode: db.BudgetModeSpread, created: d(2026, 1, 1), amount: 300}
	full := spread
	full.mode = db.BudgetModeFull
	for _, m := range []time.Time{d(2026, 1, 1), d(2026, 6, 1), d(2027, 2, 1)} {
		if a, b := monthShare(spread, m), monthShare(full, m); a != b || a != 300 {
			t.Errorf("%s spread %d, full %d, want 300", m.Format("2006-01"), a, b)
		}
	}
}
