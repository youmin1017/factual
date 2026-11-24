package ledger

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/ledger/internal/db"
)

func TestShareBalancesInPriorityOrder(t *testing.T) {
	env, other := uuid.New(), uuid.New()
	racket := goal{id: uuid.New(), envelope: env, kind: db.GoalKindTarget, target: 3500}
	weekly := goal{id: uuid.New(), envelope: env, kind: db.GoalKindMonthly, monthly: 500}
	phones := goal{id: uuid.New(), envelope: env, kind: db.GoalKindTarget, target: 4000}
	elsewhere := goal{id: uuid.New(), envelope: other, kind: db.GoalKindTarget, target: 1000}
	done := goal{id: uuid.New(), envelope: env, kind: db.GoalKindTarget, target: 9000, achieved: d(2026, 10, 1)}
	nowhere := goal{id: uuid.New(), kind: db.GoalKindTarget, target: 100}
	goals := []goal{done, racket, weekly, phones, elsewhere, nowhere}

	saved := shareBalances(goals, map[uuid.UUID]int64{env: 6000, other: -300}, goal.open, 0)
	want := map[uuid.UUID]int64{racket.id: 3500, phones.id: 2500, weekly.id: 0, elsewhere.id: 0}
	for id, w := range want {
		if saved[id] != w {
			t.Errorf("saved[%v] = %d, want %d", id, saved[id], w)
		}
	}
	if _, ok := saved[done.id]; ok {
		t.Error("an achieved goal took money")
	}
	if _, ok := saved[nowhere.id]; ok {
		t.Error("a goal in no envelope took money")
	}

	// A monthly goal takes what the goals with a total leave.
	saved = shareBalances(goals, map[uuid.UUID]int64{env: 9000}, goal.open, 0)
	if saved[weekly.id] != 1500 {
		t.Errorf("monthly saved %d, want 1500", saved[weekly.id])
	}
}

func TestMaintainLevelFollowsSpending(t *testing.T) {
	env := uuid.New()
	fund := goal{id: uuid.New(), envelope: env, kind: db.GoalKindMaintain, months: 6}
	trip := goal{id: uuid.New(), envelope: env, kind: db.GoalKindTarget, target: 10000}
	saved := shareBalances([]goal{fund, trip}, map[uuid.UUID]int64{env: 70000}, goal.open, 10000)
	if saved[fund.id] != 60000 || saved[trip.id] != 10000 {
		t.Fatalf("saved = %v", saved)
	}
	if got := fund.ask(saved[fund.id], d(2026, 11, 1), 12000); got != 12000 {
		t.Errorf("maintain ask = %d, want the gap 12000", got)
	}
	fund.monthly = 5000
	if got := fund.ask(saved[fund.id], d(2026, 11, 1), 12000); got != 5000 {
		t.Errorf("capped maintain ask = %d, want 5000", got)
	}
}

func TestGoalAsks(t *testing.T) {
	nov := d(2026, 11, 1)
	cases := []struct {
		name  string
		g     goal
		saved int64
		want  int64
	}{
		{"target without a monthly amount", goal{kind: db.GoalKindTarget, target: 5000}, 0, 0},
		{"target with one", goal{kind: db.GoalKindTarget, target: 5000, monthly: 800}, 0, 800},
		{"target nearly there", goal{kind: db.GoalKindTarget, target: 5000, monthly: 800}, 4700, 300},
		{"by date, rounded up", goal{kind: db.GoalKindTargetByDate, target: 10000, date: d(2027, 1, 15)}, 0, 3334},
		{"by date in its month", goal{kind: db.GoalKindTargetByDate, target: 10000, date: d(2026, 11, 30)}, 2000, 8000},
		{"by date past it", goal{kind: db.GoalKindTargetByDate, target: 10000, date: d(2026, 6, 1)}, 2000, 8000},
		{"by date full", goal{kind: db.GoalKindTargetByDate, target: 10000, date: d(2027, 6, 1)}, 10000, 0},
		{"monthly", goal{kind: db.GoalKindMonthly, monthly: 1500}, 99999, 1500},
	}
	for _, c := range cases {
		if got := c.g.ask(c.saved, nov, 0); got != c.want {
			t.Errorf("%s: ask = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestGoalActiveIn(t *testing.T) {
	g := goal{created: time.Date(2026, 9, 14, 8, 0, 0, 0, time.UTC), achieved: time.Date(2026, 11, 3, 8, 0, 0, 0, time.UTC)}
	for month, want := range map[time.Time]bool{
		d(2026, 8, 1): false, d(2026, 9, 1): true, d(2026, 10, 1): true, d(2026, 11, 1): false,
	} {
		if got := g.activeIn(month); got != want {
			t.Errorf("activeIn(%s) = %v, want %v", month.Format("2006-01"), got, want)
		}
	}
}

func TestGoalStatus(t *testing.T) {
	today := d(2026, 11, 20)
	g := goal{kind: db.GoalKindTarget, target: 3500}
	until := func(t time.Time) pgtype.Date { return pgtype.Date{Time: t, Valid: true} }
	for _, c := range []struct {
		g     goal
		saved int64
		wait  pgtype.Date
		want  api.GoalStatus
	}{
		{g, 1000, pgtype.Date{}, api.GoalStatusSaving},
		{g, 3500, pgtype.Date{}, api.GoalStatusFull},
		{g, 3500, until(d(2026, 12, 1)), api.GoalStatusWaiting},
		{g, 3500, until(today), api.GoalStatusFull},
		{goal{kind: db.GoalKindMonthly, monthly: 100}, 5000, pgtype.Date{}, api.GoalStatusSaving},
		{goal{kind: db.GoalKindTarget, target: 3500, achieved: today}, 0, pgtype.Date{}, api.GoalStatusAchieved},
	} {
		if got := goalStatus(c.g, c.saved, c.wait, today, 0); got != c.want {
			t.Errorf("status(%+v, %d) = %s, want %s", c.g, c.saved, got, c.want)
		}
	}
}
