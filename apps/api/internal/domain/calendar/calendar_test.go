package calendar

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseOfficialFile(t *testing.T) {
	raw, err := os.ReadFile("testdata/116_utf8bom.csv") // 民國 116 年, as published
	if err != nil {
		t.Fatal(err)
	}
	years, err := Parse(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(years) != 1 || years[0].Year != 2027 || len(years[0].Days) != 365 {
		t.Fatalf("years = %+v", years)
	}
	byDate := map[time.Time]Day{}
	for _, d := range years[0].Days {
		byDate[d.Date] = d
	}
	check := func(y int, m time.Month, dd int, off bool, note string) {
		t.Helper()
		got := byDate[time.Date(y, m, dd, 0, 0, 0, 0, time.UTC)]
		if got.Off != off || got.Note != note {
			t.Errorf("%d-%02d-%02d = %+v, want off=%v note=%q", y, m, dd, got, off, note)
		}
	}
	check(2027, 1, 1, true, "開國紀念日")
	check(2027, 1, 2, true, "")   // Saturday
	check(2027, 1, 4, false, "")  // Monday
	check(2027, 2, 9, true, "補假") // a Tuesday off
}

func TestParseRejects(t *testing.T) {
	for name, text := range map[string]string{
		"empty":        "",
		"header only":  "西元日期,星期,是否放假,備註\n",
		"bad flag":     "20270101,五,1,\n",
		"bad date":     "2027-01-01,五,2,\n",
		"partial year": "20270101,五,2,開國紀念日\n20270102,六,2,\n",
		"not UTF-8":    "\xa6\xe8\xa4\xb8",
	} {
		if _, err := Parse(text); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A repeated day is caught before the count.
	_, err := Parse("20270101,五,2,\n20270101,五,2,\n")
	if err == nil || !strings.Contains(err.Error(), "twice") {
		t.Errorf("duplicate day: %v", err)
	}
}
