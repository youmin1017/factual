package ledger

import (
	"errors"
	"sort"
	"time"

	"github.com/teambition/rrule-go"

	"factual/apps/api/internal/domain/ledger/internal/db"
)

// Schedule rules and what they ask of envelopes, without the database
// (ADR-084..086). Dates are days: midnight UTC.

// shiftPad is more than the longest run of days off (Lunar New Year), so
// an occurrence posted up to this far from its own date is still found.
const shiftPad = 20 * 24 * time.Hour

// rule is a schedule's recurrence with how it moves off days off.
type rule struct {
	rr    *rrule.RRule
	shift db.HolidayShift
	// off reports whether a day is off (ADR-087).
	off func(time.Time) bool
}

// occurrence is one date a schedule gives.
type occurrence struct {
	// Nominal is the date the rule gives; it identifies the occurrence.
	Nominal time.Time
	// Date is when it is posted: Nominal moved off days off.
	Date time.Time
}

var errRule = errors.New("invalid rule")

// parseRule reads an RRULE (without DTSTART) anchored at start. Only daily
// and longer frequencies make sense for transactions.
func parseRule(text string, start time.Time) (*rrule.RRule, error) {
	opt, err := rrule.StrToROptionInLocation(text, time.UTC)
	if err != nil {
		return nil, errRule
	}
	switch opt.Freq {
	case rrule.DAILY, rrule.WEEKLY, rrule.MONTHLY, rrule.YEARLY:
	default:
		return nil, errRule
	}
	if len(opt.Byhour) > 0 || len(opt.Byminute) > 0 || len(opt.Bysecond) > 0 {
		return nil, errRule
	}
	opt.Dtstart = day(start)
	rr, err := rrule.NewRRule(*opt)
	if err != nil {
		return nil, errRule
	}
	return rr, nil
}

func day(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func addDays(t time.Time, n int) time.Time { return t.AddDate(0, 0, n) }

// move shifts a date off days off as the schedule says.
func (r rule) move(d time.Time) time.Time {
	step := 0
	switch r.shift {
	case db.HolidayShiftNextWorkday:
		step = 1
	case db.HolidayShiftPrevWorkday:
		step = -1
	default:
		return d
	}
	for i := 0; i < 31 && r.off(d); i++ {
		d = addDays(d, step)
	}
	return d
}

// between returns the occurrences posted from from to to (inclusive),
// ordered by posting date.
func (r rule) between(from, to time.Time) []occurrence {
	nominal := r.rr.Between(from.Add(-shiftPad), to.Add(shiftPad), true)
	out := make([]occurrence, 0, len(nominal))
	for _, n := range nominal {
		o := occurrence{Nominal: day(n), Date: r.move(day(n))}
		if !o.Date.Before(from) && !o.Date.After(to) {
			out = append(out, o)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Date.Before(out[j].Date) })
	return out
}

// next returns the first occurrence on or after from that is neither posted
// nor skipped, or false when the rule has ended.
func (r rule) next(from time.Time, posted, skipped map[time.Time]bool) (occurrence, bool) {
	t := r.rr.After(day(from), true)
	for i := 0; i < 10000 && !t.IsZero(); i++ {
		n := day(t)
		if !posted[n] && !skipped[n] {
			return occurrence{Nominal: n, Date: r.move(n)}, true
		}
		t = r.rr.After(t, false)
	}
	return occurrence{}, false
}

// isOccurrence reports whether the rule gives that day.
func (r rule) isOccurrence(d time.Time) bool {
	return len(r.rr.Between(day(d), day(d), true)) == 1
}

// monthIndex counts months, so that differences are numbers of months.
func monthIndex(t time.Time) int { return t.Year()*12 + int(t.Month()) - 1 }

// targetInput is what a schedule needs to say what it asks of a month.
type targetInput struct {
	rule rule
	mode db.BudgetMode
	// created is when the schedule was made; a first occurrence is spread
	// over the months from then.
	created time.Time
	skipped map[time.Time]bool
	// amount is what one occurrence takes from the envelope (spending is
	// positive).
	amount int64
}

// targetWindow is how far around a month occurrences are looked at when
// spreading: an occurrence can ask for money at most this many months
// before it.
const targetWindow = 25

// monthShare is what the schedule asks of its envelope in the month (ADR-086):
// full counts every occurrence posted in the month; spread divides each
// occurrence evenly over the months after the previous one up to its own,
// the remainder on its own month.
func monthShare(in targetInput, month time.Time) int64 {
	if in.mode == db.BudgetModeNone || in.amount == 0 {
		return 0
	}
	m := monthIndex(month)
	if in.mode == db.BudgetModeFull {
		from := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
		var sum int64
		for _, o := range in.rule.between(from, from.AddDate(0, 1, -1)) {
			if !in.skipped[o.Nominal] {
				sum += in.amount
			}
		}
		return sum
	}

	var sum int64
	for _, sp := range in.spans(month) {
		mk := monthIndex(sp.occ.Date)
		if m > mk || m < mk-sp.n+1 || in.skipped[sp.occ.Nominal] {
			continue
		}
		share := in.amount / int64(sp.n)
		if m == mk {
			share += in.amount % int64(sp.n)
		}
		sum += share
	}
	return sum
}

// span is a spread occurrence and the number of months it is spread over,
// its own month the last (ADR-086).
type span struct {
	occ occurrence
	n   int
}

// spans are the occurrences around the month that a spread schedule asks
// money for: each over the months after the one before it, the first from
// the month the schedule was made (but over no more months than the gap to
// the next).
func (in targetInput) spans(month time.Time) []span {
	from := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -targetWindow, 0)
	to := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, targetWindow+1, -1)
	occ := in.rule.between(from, to)
	first := day(in.rule.rr.After(in.rule.rr.GetDTStart(), true))
	out := make([]span, 0, len(occ))
	for k, o := range occ {
		mk := monthIndex(o.Date)
		var n int
		switch {
		case k > 0:
			n = mk - monthIndex(occ[k-1].Date)
		case o.Nominal.Equal(first):
			n = mk - monthIndex(in.created) + 1
			if k+1 < len(occ) {
				if gap := monthIndex(occ[k+1].Date) - mk; gap > 0 && gap < n {
					n = gap
				}
			}
		default:
			continue // its previous occurrence is before the window
		}
		out = append(out, span{occ: o, n: max(n, 1)})
	}
	return out
}

// setAside is what the schedule's envelope holds for it at the end of the
// month (ADR-095): of every occurrence still to come then (dated after the
// month) or not posted yet, the part budgeted in that month or before it.
// A full schedule is budgeted in its own month; a spread one over the
// months before it.
func setAside(in targetInput, month time.Time, posted map[time.Time]bool) int64 {
	if in.mode == db.BudgetModeNone || in.amount == 0 {
		return 0
	}
	start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, -1)
	pending := func(o occurrence) bool {
		return !in.skipped[o.Nominal] && (o.Date.After(end) || !posted[o.Nominal])
	}
	var sum int64
	if in.mode == db.BudgetModeFull {
		for _, o := range in.rule.between(start.AddDate(0, -targetWindow, 0), end) {
			if pending(o) {
				sum += in.amount
			}
		}
		return sum
	}
	m := monthIndex(month)
	for _, sp := range in.spans(month) {
		mk := monthIndex(sp.occ.Date)
		lo := mk - sp.n + 1
		if lo > m || !pending(sp.occ) {
			continue
		}
		sum += int64(min(m, mk)-lo+1) * (in.amount / int64(sp.n))
		if mk <= m {
			sum += in.amount % int64(sp.n)
		}
	}
	return sum
}
