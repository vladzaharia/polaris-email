package genesis

import (
	"errors"
	"testing"
)

func TestIsAlreadyBootstrapped(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"plain", errors.New("boom"), false},
		{"typed", &AlreadyBootstrappedError{Message: "x"}, true},
		{"wrapped", &wrappedErr{inner: &AlreadyBootstrappedError{Message: "x"}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsAlreadyBootstrapped(tc.err); got != tc.want {
				t.Errorf("IsAlreadyBootstrapped(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

type wrappedErr struct {
	inner error
}

func (e *wrappedErr) Error() string { return "wrapped: " + e.inner.Error() }
func (e *wrappedErr) Unwrap() error { return e.inner }

func TestDecodeAlreadyBootstrapped(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool // expect AlreadyBootstrappedError
	}{
		{
			"canonical",
			`{"error":{"code":"already_bootstrapped","message":"x"}}`,
			true,
		},
		{
			"plain conflict",
			`{"error":{"code":"conflict","message":"x"}}`,
			true,
		},
		{
			"other code in 409",
			`{"error":{"code":"rate_limited","message":"x"}}`,
			false,
		},
		{
			"unparseable",
			`<html>oops</html>`,
			true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := decodeAlreadyBootstrapped([]byte(tc.body))
			got := IsAlreadyBootstrapped(err)
			if got != tc.want {
				t.Errorf("body=%q → IsAlreadyBootstrapped=%v want=%v (err=%v)",
					tc.body, got, tc.want, err)
			}
		})
	}
}

func TestAlreadyBootstrappedError_Default(t *testing.T) {
	var e *AlreadyBootstrappedError
	if e.Error() == "" {
		t.Error("nil receiver should return non-empty error string")
	}
}
