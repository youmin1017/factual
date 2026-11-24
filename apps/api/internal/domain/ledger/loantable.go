package ledger

// The loan table (ADR-096, ADR-097): every period of a loan worked out from
// its terms, and from the period Factual tracks on, from what the ledger
// says the loan still owes. Nothing here is stored.

import (
	"math"
	"sort"
	"time"
)

// rateScale is how loan rates are counted: ten-thousandths of a percent,
// so 2.35% is 23500 (loan_rates.annual_rate has four decimals).
const rateScale = 1_000_000

type loanRate struct {
	from time.Time
	rate int64
}

type loanTerms struct {
	principal      int64
	months         int
	start          time.Time // 撥款日
	firstPayment   time.Time // its day of the month is the payment day
	equalPrincipal bool
	grace          int
	reducePayment  bool
	rates          []loanRate // oldest first; the first applies from 撥款日
}

// loanMove is an entry on the loan account not posted by its schedule: an
// opening balance, a payment entered by hand, an extra payment or an
// alignment. A positive amount lowers what is owed.
type loanMove struct {
	date   time.Time
	amount int64
}

// loanPaid is what a posted occurrence of the loan's schedule paid.
type loanPaid struct {
	principal, interest int64
}

// loanActual is the ledger's side of a loan, from the first period its
// schedule pays (from) on.
type loanActual struct {
	from    time.Time
	moves   []loanMove // by date
	posted  map[time.Time]loanPaid
	skipped map[time.Time]bool
}

type loanPeriod struct {
	n         int
	date      time.Time // the nominal payment date
	rate      int64
	principal int64
	interest  int64
	balance   int64 // what is owed after it
	tracked   bool  // paid by the schedule rather than before Factual
	posted    bool
	skipped   bool
}

// periodDate is the date of the nth payment: the first payment's day,
// months later, or the month's last day when it has no such day.
func periodDate(first time.Time, n int) time.Time {
	y, m, d := first.Date()
	start := time.Date(y, m+time.Month(n-1), 1, 0, 0, 0, 0, time.UTC)
	last := start.AddDate(0, 1, -1).Day()
	return time.Date(start.Year(), start.Month(), min(d, last), 0, 0, 0, 0, time.UTC)
}

// rateOn is the rate in effect on the day.
func rateOn(rates []loanRate, day time.Time) int64 {
	if len(rates) == 0 {
		return 0
	}
	r := rates[0].rate
	for _, x := range rates {
		if x.from.After(day) {
			break
		}
		r = x.rate
	}
	return r
}

// divRound is a/b rounded half up, for a >= 0 and b > 0.
func divRound(a, b int64) int64 { return (a + b/2) / b }

// monthInterest is a month's interest on what is owed: the annual rate
// divided by twelve.
func monthInterest(owed, rate int64) int64 { return divRound(owed*rate, 12*rateScale) }

// dayInterest is the interest for a number of days, counted over 365.
func dayInterest(owed, rate int64, days int) int64 {
	return divRound(owed*rate*int64(days), 365*rateScale)
}

// monthRate is the monthly rate as a fraction.
func monthRate(rate int64) float64 { return float64(rate) / rateScale / 12 }

// annuity is the level payment that repays owed over n months.
func annuity(owed int64, n int, rate int64) int64 {
	if n <= 1 {
		return owed + monthInterest(owed, rate)
	}
	i := monthRate(rate)
	if i == 0 {
		return int64(math.Ceil(float64(owed) / float64(n)))
	}
	return int64(math.Round(float64(owed) * i / (1 - math.Pow(1+i, -float64(n)))))
}

// monthsToRepay is how many months a level payment takes to repay owed;
// limit when it never does.
func monthsToRepay(owed, payment, rate int64, limit int) int {
	if payment <= 0 {
		return limit
	}
	i := monthRate(rate)
	if i == 0 {
		return int(min(int64(limit), (owed+payment-1)/payment))
	}
	x := 1 - float64(owed)*i/float64(payment)
	if x <= 0 {
		return limit
	}
	n := int(math.Ceil(-math.Log(x)/math.Log(1+i) - 1e-9))
	return max(1, min(n, limit))
}

// loanTable is every period of the loan. Without actual it follows the
// terms alone. With it, the periods from actual.from start from what the
// ledger says is owed, which takes in extra payments and alignments, and a
// posted period counts what it actually paid. Between payments, entries
// count from the next period on. The table ends when nothing is owed.
func loanTable(t loanTerms, a *loanActual) []loanPeriod {
	if t.principal <= 0 || t.months <= 0 || len(t.rates) == 0 {
		return nil
	}
	monthly := periodDate(t.start, 2).Equal(t.firstPayment)
	var moves []loanMove
	if a != nil {
		moves = append(moves, a.moves...)
		sort.SliceStable(moves, func(i, j int) bool { return moves[i].date.Before(moves[j].date) })
	}
	next := 0
	// take counts the moves dated up to the day.
	take := func(day time.Time) int64 {
		var sum int64
		for next < len(moves) && !moves[next].date.After(day) {
			sum += moves[next].amount
			next++
		}
		return sum
	}

	var out []loanPeriod
	owed := t.principal
	expected := owed // what is owed when the payment was last set
	var level int64  // the annuity's payment, or the principal repaid each month
	var prevRate int64
	tracking := false
	limit := t.months + 120
	for n := 1; n <= limit; n++ {
		date := periodDate(t.firstPayment, n)
		prev := t.start
		if n > 1 {
			prev = periodDate(t.firstPayment, n-1)
		}
		if a != nil && !tracking && !date.Before(a.from) {
			tracking = true
			owed = -take(prev)
		}
		if owed <= 0 {
			break
		}
		rateDay := t.start
		if n > 1 {
			rateDay = prev.AddDate(0, 0, 1)
		}
		p := loanPeriod{n: n, date: date, rate: rateOn(t.rates, rateDay), tracked: tracking}

		if tracking && a.skipped[date] {
			p.skipped = true
		} else {
			if n == 1 && !monthly {
				p.interest = dayInterest(owed, p.rate, int(date.Sub(t.start).Hours()/24))
			} else {
				p.interest = monthInterest(owed, p.rate)
			}
			if n > t.grace {
				left := max(t.months-n+1, 1)
				first := n == t.grace+1
				changed := owed != expected
				switch {
				case t.equalPrincipal:
					if first || (t.reducePayment && changed) {
						level = divRound(owed, int64(left))
					}
					p.principal = level
				default:
					if first || (t.reducePayment && changed) {
						level = annuity(owed, left, p.rate)
					} else if p.rate != prevRate {
						// A new rate keeps the end the payment was heading for,
						// unless extra payments are to lower the payment.
						m := left
						if !t.reducePayment {
							m = min(monthsToRepay(owed, level, prevRate, limit), left)
						}
						level = annuity(owed, m, p.rate)
					}
					p.principal = max(level-p.interest, 0)
				}
				if left == 1 || n >= t.months || p.principal > owed {
					p.principal = owed
				}
			}
		}
		if paid, ok := a.paid(date, tracking); ok {
			p.principal, p.interest, p.posted, p.skipped = paid.principal, paid.interest, true, false
		}
		owed -= p.principal
		expected = owed
		if tracking {
			owed -= take(date)
		}
		p.balance = max(owed, 0)
		prevRate = p.rate
		out = append(out, p)
	}
	return out
}

// paid is what the schedule's occurrence on the date posted, if it did.
func (a *loanActual) paid(date time.Time, tracking bool) (loanPaid, bool) {
	if a == nil || !tracking {
		return loanPaid{}, false
	}
	p, ok := a.posted[date]
	return p, ok
}
