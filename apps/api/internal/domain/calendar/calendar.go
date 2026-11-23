// Package calendar knows which days are off (ADR-087): the government's
// office calendar (行政機關辦公日曆表), imported per year by the instance
// admin, and Saturdays and Sundays for years without one.
package calendar

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"factual/apps/api/internal/api"
	"factual/apps/api/internal/domain/calendar/internal/db"
	"factual/apps/api/internal/shared/apperr"
	"factual/apps/api/internal/shared/reqctx"
)

const (
	maxFileBytes = 1 << 20
	fetchTimeout = 10 * time.Second
)

// Service reads and imports the calendar.
type Service struct {
	pool   *pgxpool.Pool
	q      *db.Queries
	client *http.Client
}

// New builds the service on the app database.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, q: db.New(pool), client: &http.Client{Timeout: fetchTimeout}}
}

// Handlers are the domain's API operations.
type Handlers struct{ s *Service }

// Handlers returns the domain's API operations.
func (s *Service) Handlers() *Handlers { return &Handlers{s: s} }

// Weekend is the rule for days of years without an imported calendar.
func Weekend(d time.Time) bool {
	wd := d.Weekday()
	return wd == time.Saturday || wd == time.Sunday
}

// DaysOff returns whether a day is off, from the calendar of the days
// between from and to; any other day follows the weekend rule.
func (s *Service) DaysOff(ctx context.Context, from, to time.Time) (func(time.Time) bool, error) {
	if s == nil {
		return Weekend, nil
	}
	days, err := s.q.ListDays(ctx, db.ListDaysParams{FromDate: from, ToDate: to})
	if err != nil {
		return nil, err
	}
	off := make(map[time.Time]bool, len(days))
	for _, d := range days {
		off[dateOnly(d.Date)] = d.IsOff
	}
	return func(d time.Time) bool {
		if v, ok := off[dateOnly(d)]; ok {
			return v
		}
		return Weekend(d)
	}, nil
}

func dateOnly(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func (h *Handlers) GetHolidays(ctx context.Context, req api.GetHolidaysRequestObject) (api.GetHolidaysResponseObject, error) {
	from, to := req.Params.From, req.Params.To
	if from < 1900 || to > 2999 || to < from || to-from > 10 {
		return nil, apperr.BadRequest("invalid_range", "from and to are years, at most ten apart")
	}
	years, err := h.s.q.CoveredYears(ctx, db.CoveredYearsParams{FromYear: from, ToYear: to})
	if err != nil {
		return nil, err
	}
	days, err := h.s.q.ListDays(ctx, db.ListDaysParams{
		FromDate: time.Date(int(from), 1, 1, 0, 0, 0, 0, time.UTC),
		ToDate:   time.Date(int(to), 12, 31, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		return nil, err
	}
	out := api.HolidayCalendar{Years: years, Days: []api.Holiday{}}
	if out.Years == nil {
		out.Years = []int32{}
	}
	for _, d := range days {
		if d.IsOff != Weekend(d.Date) || d.Note != "" {
			out.Days = append(out.Days, api.Holiday{Date: openapi_types.Date{Time: d.Date}, Off: d.IsOff, Note: d.Note})
		}
	}
	return api.GetHolidays200JSONResponse(out), nil
}

func (h *Handlers) ListHolidayYears(ctx context.Context, _ api.ListHolidayYearsRequestObject) (api.ListHolidayYearsResponseObject, error) {
	years, err := h.s.listYears(ctx, nil)
	if err != nil {
		return nil, err
	}
	return api.ListHolidayYears200JSONResponse(years), nil
}

// listYears returns the imported years, only those in only when it is not nil.
func (s *Service) listYears(ctx context.Context, only map[int32]bool) ([]api.HolidayYear, error) {
	rows, err := s.q.ListYears(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]api.HolidayYear, 0, len(rows))
	for _, r := range rows {
		if only != nil && !only[r.Year] {
			continue
		}
		y := api.HolidayYear{
			Year: r.Year, SourceUrl: r.SourceUrl, Days: r.Days, DaysOff: r.DaysOff, ImportedAt: r.ImportedAt,
		}
		if r.ImportedBy.Valid {
			y.ImportedBy = &r.ImportedBy.String
		}
		out = append(out, y)
	}
	return out, nil
}

func (h *Handlers) ImportHolidays(ctx context.Context, req api.ImportHolidaysRequestObject) (api.ImportHolidaysResponseObject, error) {
	b := req.Body
	src, text := "", ""
	switch {
	case b.Url != nil && strings.TrimSpace(*b.Url) != "" && (b.Csv == nil || *b.Csv == ""):
		src = strings.TrimSpace(*b.Url)
		body, err := h.s.fetch(ctx, src)
		if err != nil {
			return nil, err
		}
		text = body
	case b.Csv != nil && *b.Csv != "" && (b.Url == nil || strings.TrimSpace(*b.Url) == ""):
		text = *b.Csv
	default:
		return nil, apperr.BadRequest("invalid_import", "give either a url or the csv text")
	}
	years, err := Parse(text)
	if err != nil {
		return nil, apperr.BadRequest("invalid_calendar", err.Error())
	}
	by := pgtype.UUID{Bytes: reqctx.Caller(ctx).UserID, Valid: true}
	tx, err := h.s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := h.s.q.WithTx(tx)
	imported := map[int32]bool{}
	for _, y := range years {
		if err := q.DeleteYearDays(ctx, y.Year); err != nil {
			return nil, err
		}
		p := db.InsertDaysParams{}
		off := int32(0)
		for _, d := range y.Days {
			p.Dates = append(p.Dates, d.Date)
			p.Offs = append(p.Offs, d.Off)
			p.Notes = append(p.Notes, d.Note)
			if d.Off {
				off++
			}
		}
		if err := q.InsertDays(ctx, p); err != nil {
			return nil, err
		}
		err := q.UpsertYear(ctx, db.UpsertYearParams{
			Year: y.Year, SourceUrl: src, Days: int32(len(y.Days)), DaysOff: off, ImportedBy: by,
		})
		if err != nil {
			return nil, err
		}
		imported[y.Year] = true
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out, err := h.s.listYears(ctx, imported)
	if err != nil {
		return nil, err
	}
	return api.ImportHolidays200JSONResponse(out), nil
}

func (h *Handlers) DeleteHolidayYear(ctx context.Context, req api.DeleteHolidayYearRequestObject) (api.DeleteHolidayYearResponseObject, error) {
	tx, err := h.s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := h.s.q.WithTx(tx)
	n, err := q.DeleteYear(ctx, req.Year)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apperr.New(http.StatusNotFound, "not_found", "year not imported")
	}
	if err := q.DeleteYearDays(ctx, req.Year); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return api.DeleteHolidayYear204Response{}, nil
}

// fetch downloads a calendar file the admin pointed at.
func (s *Service) fetch(ctx context.Context, raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", apperr.BadRequest("invalid_url", "the url must start with http:// or https://")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", apperr.BadRequest("invalid_url", err.Error())
	}
	res, err := s.client.Do(req)
	if err != nil {
		return "", apperr.BadRequest("fetch_failed", "could not download the file: "+err.Error())
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return "", apperr.BadRequest("fetch_failed", "the server answered "+res.Status)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxFileBytes+1))
	if err != nil {
		return "", apperr.BadRequest("fetch_failed", "could not download the file: "+err.Error())
	}
	if len(body) > maxFileBytes {
		return "", apperr.BadRequest("fetch_failed", "the file is larger than 1 MB")
	}
	return string(body), nil
}

// Day is one day of an imported calendar.
type Day struct {
	Date time.Time
	Off  bool
	Note string
}

// Year is the days of one imported year, in order.
type Year struct {
	Year int32
	Days []Day
}

// Parse reads the official CSV (西元日期,星期,是否放假,備註): one line per
// day, 2 = off and 0 = working, UTF-8 with or without BOM. Every year in it
// must be complete.
func Parse(text string) ([]Year, error) {
	if !utf8.ValidString(text) {
		return nil, errors.New("the file is not UTF-8; use the official file whose name ends in utf8bom.csv")
	}
	text = strings.TrimPrefix(text, "\ufeff")
	r := csv.NewReader(bytes.NewBufferString(text))
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true
	records, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("not a CSV file: %w", err)
	}
	byYear := map[int32][]Day{}
	seen := map[time.Time]bool{}
	for i, rec := range records {
		if len(rec) == 0 || (len(rec) == 1 && strings.TrimSpace(rec[0]) == "") {
			continue
		}
		first := strings.TrimSpace(rec[0])
		if i == 0 && !isDigits(first) {
			continue // the header
		}
		if len(rec) < 3 {
			return nil, fmt.Errorf("line %d: expected 西元日期,星期,是否放假,備註", i+1)
		}
		d, err := time.Parse("20060102", first)
		if err != nil {
			return nil, fmt.Errorf("line %d: %q is not a date like 20270101", i+1, first)
		}
		var off bool
		switch strings.TrimSpace(rec[2]) {
		case "2":
			off = true
		case "0":
		default:
			return nil, fmt.Errorf("line %d: 是否放假 is %q, expected 2 or 0", i+1, rec[2])
		}
		if seen[d] {
			return nil, fmt.Errorf("line %d: %s appears twice", i+1, first)
		}
		seen[d] = true
		note := ""
		if len(rec) > 3 {
			note = strings.TrimSpace(rec[3])
		}
		y := int32(d.Year())
		byYear[y] = append(byYear[y], Day{Date: d, Off: off, Note: note})
	}
	if len(byYear) == 0 {
		return nil, errors.New("the file has no days")
	}
	out := make([]Year, 0, len(byYear))
	for y, days := range byYear {
		want := time.Date(int(y)+1, 1, 1, 0, 0, 0, 0, time.UTC).Sub(time.Date(int(y), 1, 1, 0, 0, 0, 0, time.UTC)).Hours() / 24
		if len(days) != int(want) {
			return nil, fmt.Errorf("%d has %d days in the file, not %d: import whole years", y, len(days), int(want))
		}
		sort.Slice(days, func(i, j int) bool { return days[i].Date.Before(days[j].Date) })
		out = append(out, Year{Year: y, Days: days})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Year < out[j].Year })
	return out, nil
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
