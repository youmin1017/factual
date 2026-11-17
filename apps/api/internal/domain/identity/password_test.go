package identity

import "testing"

func TestHashAndVerifyPassword(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := VerifyPassword("correct horse", h); err != nil || !ok {
		t.Errorf("right password: ok=%v err=%v", ok, err)
	}
	if ok, err := VerifyPassword("wrong horse", h); err != nil || ok {
		t.Errorf("wrong password: ok=%v err=%v", ok, err)
	}
	h2, _ := HashPassword("correct horse")
	if h == h2 {
		t.Error("hashes must be salted")
	}
}

func TestVerifyPasswordRejectsMalformedHash(t *testing.T) {
	for _, h := range []string{"", "plain", "$argon2i$v=19$m=1,t=1,p=1$c2FsdA$a2V5", "$argon2id$v=19$m=x$c2FsdA$a2V5"} {
		if _, err := VerifyPassword("x", h); err == nil {
			t.Errorf("%q: expected error", h)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := truncate("héllo", 2); got != "hé" {
		t.Errorf("got %q", got)
	}
	if got := truncate("ok", 5); got != "ok" {
		t.Errorf("got %q", got)
	}
}
