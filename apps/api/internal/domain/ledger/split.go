package ledger

import (
	"math"
	"math/big"
)

// How a shared expense's total is divided (ADR-106). The browser divides it
// the same way to show the shares before saving (apps/web/src/lib/split.ts);
// keep the two in step.

// weightScale is how finely weights are kept: numeric(12, 4).
const weightScale = 10000

// scaledWeight is a weight in ten-thousandths, or false when it cannot be
// one (negative, not finite, too large for numeric(12, 4)).
func scaledWeight(w float64) (int64, bool) {
	if math.IsNaN(w) || math.IsInf(w, 0) || w < 0 || w >= 1e8 {
		return 0, false
	}
	return int64(math.Round(w * weightScale)), true
}

// divide splits total in proportion to weights (already scaled, at least
// one positive) by the largest remainder method: everyone gets the floor of
// their exact part, and the units left over go to the largest remainders,
// ties to the earlier weight. The parts always add up to total.
func divide(total int64, weights []int64) []int64 {
	var sum int64
	for _, w := range weights {
		sum += w
	}
	parts := make([]int64, len(weights))
	rems := make([]*big.Int, len(weights))
	bigTotal, bigSum := big.NewInt(total), big.NewInt(sum)
	left := total
	for i, w := range weights {
		q, r := new(big.Int).QuoRem(new(big.Int).Mul(bigTotal, big.NewInt(w)), bigSum, new(big.Int))
		parts[i] = q.Int64()
		rems[i] = r
		left -= parts[i]
	}
	for ; left > 0; left-- {
		best := -1
		for i, r := range rems {
			if weights[i] > 0 && (best < 0 || r.Cmp(rems[best]) > 0) {
				best = i
			}
		}
		parts[best]++
		rems[best] = big.NewInt(-1) // one extra unit each
	}
	return parts
}

// fxRate is how many units of the expense's currency one unit of the
// foreign one cost, with eight decimals as numeric(18, 8) keeps it.
func fxRate(total int64, totalUnits int32, foreign int64, foreignUnits int32) string {
	r := new(big.Rat).SetFrac(
		new(big.Int).Mul(big.NewInt(total), pow10(foreignUnits)),
		new(big.Int).Mul(big.NewInt(foreign), pow10(totalUnits)),
	)
	return r.FloatString(8)
}

func pow10(n int32) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
}
