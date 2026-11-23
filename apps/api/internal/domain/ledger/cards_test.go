package ledger

import (
	"testing"
	"time"
)

func ymd(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func TestCardCycle(t *testing.T) {
	never := func(time.Time) bool { return false }
	for _, c := range []struct {
		name string
		got  time.Time
		want time.Time
	}{
		{"a month without the day closes on its last", closingDay(2027, time.February, 31), ymd(2027, 2, 28)},
		{"months run on past December", closingDay(2026, 13, 5), ymd(2027, 1, 5)},
		{"and back before January", closingDay(2027, 0, 5), ymd(2026, 12, 5)},
		{"the statement day itself", closingOnOrAfter(ymd(2026, 11, 5), 5), ymd(2026, 11, 5)},
		{"after it, the next month's", closingOnOrAfter(ymd(2026, 11, 6), 5), ymd(2026, 12, 5)},
		{"day 31 in November", closingOnOrAfter(ymd(2026, 11, 20), 31), ymd(2026, 11, 30)},
		{"due later in the same month", dueFor(ymd(2026, 12, 5), 5, 25, never), ymd(2026, 12, 25)},
		{"due the next month", dueFor(ymd(2026, 11, 25), 25, 10, never), ymd(2026, 12, 10)},
		{"due on the same day number: next month", dueFor(ymd(2026, 11, 15), 15, 15, never), ymd(2026, 12, 15)},
		{"due day 31 in February", dueFor(ymd(2027, 1, 31), 31, 31, never), ymd(2027, 2, 28)},
		// 2026-12-26 is a Saturday.
		{"a due date off work moves to Monday", dueFor(ymd(2026, 12, 5), 5, 26, weekend), ymd(2026, 12, 28)},
	} {
		if !c.got.Equal(c.want) {
			t.Errorf("%s: %s, want %s", c.name, c.got.Format(time.DateOnly), c.want.Format(time.DateOnly))
		}
	}
}
