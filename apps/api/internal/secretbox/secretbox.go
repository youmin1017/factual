// Package secretbox encrypts small values with AES-256-GCM under the key
// from FACTUAL_ENCRYPTION_KEY: OIDC client secrets at rest
// and the short-lived OIDC flow cookie.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// prefix versions the format so the key or algorithm can change later.
const prefix = "v1:"

var (
	ErrNoKey     = errors.New("FACTUAL_ENCRYPTION_KEY is not set")
	ErrMalformed = errors.New("malformed or tampered ciphertext")
)

// Box seals and opens values. A Box without a key fails every call with ErrNoKey.
type Box struct {
	aead cipher.AEAD
}

// New builds a Box from a base64-encoded 32-byte key; an empty key gives a
// Box that reports ErrNoKey.
func New(base64Key string) (*Box, error) {
	if base64Key == "" {
		return &Box{}, nil
	}
	key, err := base64.StdEncoding.DecodeString(base64Key)
	if err != nil || len(key) != 32 {
		return nil, errors.New("FACTUAL_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plaintext; additional binds the ciphertext to a context
// (e.g. "oidc-secret") so it cannot be replayed elsewhere.
func (b *Box) Seal(plaintext []byte, additional string) (string, error) {
	if b.aead == nil {
		return "", ErrNoKey
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, plaintext, []byte(additional))
	return prefix + base64.RawURLEncoding.EncodeToString(out), nil
}

// Open decrypts a value from Seal with the same additional data.
func (b *Box) Open(sealed, additional string) ([]byte, error) {
	if b.aead == nil {
		return nil, ErrNoKey
	}
	raw, ok := strings.CutPrefix(sealed, prefix)
	if !ok {
		return nil, ErrMalformed
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(data) < b.aead.NonceSize() {
		return nil, ErrMalformed
	}
	n := b.aead.NonceSize()
	out, err := b.aead.Open(nil, data[:n], data[n:], []byte(additional))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return out, nil
}

// HasKey reports whether the Box can seal and open values.
func (b *Box) HasKey() bool { return b != nil && b.aead != nil }
