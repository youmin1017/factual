package ledger

import (
	"testing"
	"time"
)

func sumPrincipal(ps []loanPeriod) int64 {
	var s int64
	for _, p := range ps {
		s += p.principal
	}
	return s
}

func homeLoan() loanTerms {
	return loanTerms{
		principal: 1_000_000, months: 240,
		start: d(2026, 1, 10), firstPayment: d(2026, 2, 10),
		rates: []loanRate{{d(2026, 1, 10), 20000}}, // 2%
	}
}

func TestPeriodDate(t *testing.T) {
	first := d(2026, 1, 31)
	for n, want := range map[int]time.Time{1: d(2026, 1, 31), 2: d(2026, 2, 28), 3: d(2026, 3, 31), 14: d(2027, 2, 28)} {
		if got := periodDate(first, n); !got.Equal(want) {
			t.Errorf("period %d = %v, want %v", n, got, want)
		}
	}
}

// 1,000,000 at 2% over 20 years, level payments: 5,059 a month, the first
// 1,667 of it interest; the last period takes what is left, so the loan
// ends at zero after exactly 240 payments.
func TestAnnuityTable(t *testing.T) {
	ps := loanTable(homeLoan(), nil)
	if len(ps) != 240 {
		t.Fatalf("periods = %d, want 240", len(ps))
	}
	if p := ps[0]; p.interest != 1667 || p.principal+p.interest != 5059 || !p.date.Equal(d(2026, 2, 10)) {
		t.Fatalf("first period = %+v, want 1,667 interest of 5,059 on 2/10", p)
	}
	if p := ps[1]; p.principal+p.interest != 5059 {
		t.Fatalf("second payment = %d, want 5,059", p.principal+p.interest)
	}
	last := ps[len(ps)-1]
	if last.balance != 0 || sumPrincipal(ps) != 1_000_000 {
		t.Fatalf("last = %+v, principal repaid %d", last, sumPrincipal(ps))
	}
	if pay := last.principal + last.interest; pay < 5000 || pay > 5120 {
		t.Fatalf("last payment = %d, want about 5,059", pay)
	}
}

// Equal principal: 1,200,000 over a year at 2.4% repays 100,000 a month,
// and the interest falls with what is owed.
func TestEqualPrincipalTable(t *testing.T) {
	ps := loanTable(loanTerms{
		principal: 1_200_000, months: 12, start: d(2026, 1, 5), firstPayment: d(2026, 2, 5),
		equalPrincipal: true, rates: []loanRate{{d(2026, 1, 5), 24000}},
	}, nil)
	if len(ps) != 12 || ps[0].principal != 100_000 || ps[0].interest != 2400 || ps[1].interest != 2200 {
		t.Fatalf("periods = %d, first %+v, second %+v", len(ps), ps[0], ps[1])
	}
	if sumPrincipal(ps) != 1_200_000 || ps[11].balance != 0 {
		t.Fatalf("repaid %d, last %+v", sumPrincipal(ps), ps[11])
	}
}

// Two months of grace pay only interest; the rest repays over the twelve
// months left.
func TestGraceThenEqualPrincipal(t *testing.T) {
	ps := loanTable(loanTerms{
		principal: 1_200_000, months: 14, grace: 2, start: d(2026, 1, 5), firstPayment: d(2026, 2, 5),
		equalPrincipal: true, rates: []loanRate{{d(2026, 1, 5), 24000}},
	}, nil)
	if len(ps) != 14 || ps[0].principal != 0 || ps[1].principal != 0 || ps[1].interest != 2400 || ps[2].principal != 100_000 {
		t.Fatalf("periods = %d: %+v %+v %+v", len(ps), ps[0], ps[1], ps[2])
	}
}

// A first payment that is not a month after 撥款日 counts its interest by
// days: 41 days of 2% on 1,000,000 is 2,247.
func TestFirstPeriodByDays(t *testing.T) {
	terms := homeLoan()
	terms.firstPayment = d(2026, 2, 20)
	ps := loanTable(terms, nil)
	if ps[0].interest != 2247 {
		t.Fatalf("first interest = %d, want 2,247", ps[0].interest)
	}
	if !ps[1].date.Equal(d(2026, 3, 20)) || ps[1].interest >= 1667 {
		t.Fatalf("second period = %+v", ps[1])
	}
}

// A rate change recomputes the payment from that period on, keeping the end
// of the loan; earlier periods are not touched.
func TestRateChange(t *testing.T) {
	terms := homeLoan()
	terms.rates = append(terms.rates, loanRate{d(2027, 1, 11), 25000}) // 2.5% from the 13th period
	ps := loanTable(terms, nil)
	if len(ps) != 240 || sumPrincipal(ps) != 1_000_000 {
		t.Fatalf("periods = %d, repaid %d", len(ps), sumPrincipal(ps))
	}
	if pay := ps[11].principal + ps[11].interest; pay != 5059 || ps[11].rate != 20000 {
		t.Fatalf("12th = %+v", ps[11])
	}
	if p := ps[12]; p.rate != 25000 || p.principal+p.interest <= 5059 {
		t.Fatalf("13th = %+v, want a higher payment at 2.5%%", p)
	}
	if ps[13].principal+ps[13].interest != ps[12].principal+ps[12].interest {
		t.Fatalf("payments after the change differ: %d, %d", ps[12].principal+ps[12].interest, ps[13].principal+ps[13].interest)
	}
}

// From the period Factual tracks on, what is owed comes from the ledger: an
// extra payment of 100,000 shortens the loan, or with reduce_payment lowers
// the payment and keeps its end.
func TestTrackedExtraPayment(t *testing.T) {
	terms := homeLoan()
	plain := loanTable(terms, nil)
	from := d(2027, 2, 10) // period 13
	owedBefore := plain[11].balance
	actual := func() *loanActual {
		return &loanActual{
			from: from,
			moves: []loanMove{
				{d(2027, 1, 10), -owedBefore}, // the opening balance, as setup writes it
				{d(2027, 2, 20), 100_000},     // an extra payment after the 13th
			},
		}
	}
	short := loanTable(terms, actual())
	if short[12].principal+short[12].interest != 5059 || short[13].principal+short[13].interest != 5059 {
		t.Fatalf("payments around the extra = %+v %+v", short[12], short[13])
	}
	if len(short) >= 240 {
		t.Fatalf("shorten_term ends after %d periods, want fewer than 240", len(short))
	}
	if !short[12].tracked || short[11].tracked {
		t.Fatal("periods from 2027-02-10 on are tracked, earlier ones are not")
	}
	if got := sumPrincipal(short[12:]) + 100_000; got != owedBefore {
		t.Fatalf("tracked principal + extra = %d, want %d", got, owedBefore)
	}

	terms.reducePayment = true
	lower := loanTable(terms, actual())
	if len(lower) != 240 {
		t.Fatalf("reduce_payment ends after %d periods, want 240", len(lower))
	}
	// Paid between the 13th and 14th payments, it counts from the 15th.
	if pay := lower[13].principal + lower[13].interest; pay != 5059 {
		t.Fatalf("14th payment = %d, want 5,059", pay)
	}
	if pay := lower[14].principal + lower[14].interest; pay >= 5059 || pay < 4500 {
		t.Fatalf("payment after the extra = %d, want lower than 5,059", pay)
	}
}

// A posted period counts what it actually paid (the bank's own figures),
// a skipped one pays nothing, and the ledger balance carries on from them.
func TestTrackedPostedAndSkipped(t *testing.T) {
	terms := homeLoan()
	plain := loanTable(terms, nil)
	a := &loanActual{
		from:    d(2026, 2, 10),
		moves:   []loanMove{{d(2026, 1, 10), -1_000_000}},
		posted:  map[time.Time]loanPaid{d(2026, 2, 10): {principal: 3400, interest: 1660}},
		skipped: map[time.Time]bool{d(2026, 3, 10): true},
	}
	ps := loanTable(terms, a)
	if p := ps[0]; !p.posted || p.principal != 3400 || p.balance != 996_600 {
		t.Fatalf("posted = %+v", p)
	}
	if p := ps[1]; !p.skipped || p.principal != 0 || p.interest != 0 || p.balance != 996_600 {
		t.Fatalf("skipped = %+v", p)
	}
	if ps[2].interest != monthInterest(996_600, 20000) {
		t.Fatalf("third interest = %d", ps[2].interest)
	}
	if sumPrincipal(ps) != 1_000_000 || len(ps) != len(plain) {
		t.Fatalf("repaid %d over %d periods", sumPrincipal(ps), len(ps))
	}

	// Nothing owed in the ledger: no periods from then on.
	empty := loanTable(terms, &loanActual{from: d(2026, 2, 10)})
	if len(empty) != 0 {
		t.Fatalf("periods with nothing owed = %d", len(empty))
	}
}
