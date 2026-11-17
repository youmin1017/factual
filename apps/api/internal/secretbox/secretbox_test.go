package secretbox

import (
	"errors"
	"testing"
)

const testKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // 32 bytes

func TestSealOpen(t *testing.T) {
	b, err := New(testKey)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := b.Seal([]byte("s3cret"), "ctx")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := b.Open(sealed, "ctx"); err != nil || string(got) != "s3cret" {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := b.Open(sealed, "other"); !errors.Is(err, ErrMalformed) {
		t.Errorf("wrong context must fail: %v", err)
	}
	tampered := sealed[:len(sealed)-2] + "AA"
	if _, err := b.Open(tampered, "ctx"); !errors.Is(err, ErrMalformed) {
		t.Errorf("tampered value must fail: %v", err)
	}
	again, _ := b.Seal([]byte("s3cret"), "ctx")
	if again == sealed {
		t.Error("nonces must differ")
	}
}

func TestKeyValidation(t *testing.T) {
	if _, err := New("c2hvcnQ="); err == nil {
		t.Error("short key must be rejected")
	}
	empty, err := New("")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := empty.Seal([]byte("x"), ""); !errors.Is(err, ErrNoKey) {
		t.Errorf("no key: %v", err)
	}
}
