package ledger

import (
	"slices"
	"testing"
)

func TestDivide(t *testing.T) {
	for _, c := range []struct {
		name    string
		total   int64
		weights []int64
		want    []int64
	}{
		{"even", 1000, []int64{1, 1}, []int64{500, 500}},
		{"odd unit to the first", 1001, []int64{1, 1}, []int64{501, 500}},
		{"three ways", 100, []int64{1, 1, 1}, []int64{34, 33, 33}},
		{"percent", 999, []int64{40 * weightScale, 60 * weightScale}, []int64{400, 599}},
		{"largest remainder wins", 10, []int64{1, 2}, []int64{3, 7}},
		{"shares", 2400, []int64{2, 1}, []int64{1600, 800}},
		{"zero weight gets nothing", 7, []int64{0, 3}, []int64{0, 7}},
		{"large", 9_000_000_000_000, []int64{99_990_000 * weightScale, 1}, []int64{8_999_999_999_991, 9}},
	} {
		got := divide(c.total, c.weights)
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: divide(%d, %v) = %v, want %v", c.name, c.total, c.weights, got, c.want)
		}
	}
}

func TestScaledWeight(t *testing.T) {
	if w, ok := scaledWeight(33.33335); !ok || w != 333334 {
		t.Errorf("33.33335 = %d %v", w, ok)
	}
	for _, bad := range []float64{-1, 1e8} {
		if _, ok := scaledWeight(bad); ok {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestFxRate(t *testing.T) {
	// 3,000 JPY (no minor units) paid as 610 TWD (kept in 元, ADR-056).
	if got := fxRate(610, 0, 3000, 0); got != "0.20333333" {
		t.Errorf("JPY = %s", got)
	}
	// 12.50 USD (cents) paid as 400 TWD.
	if got := fxRate(400, 0, 1250, 2); got != "32.00000000" {
		t.Errorf("USD = %s", got)
	}
}
