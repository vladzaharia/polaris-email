// Operator + login API shapes — mirrors services/api/src/routes/admin/operators.ts
// and services/api/src/routes/auth.ts.
package client

import "time"

type Operator struct {
	ID                string     `json:"id"`
	Name              string     `json:"name"`
	Email             string     `json:"email"`
	SSHPubkey         string     `json:"ssh_pubkey,omitempty"`
	SSHPubkeyFPSHA256 string     `json:"ssh_pubkey_fp_sha256"`
	APIKeyID          string     `json:"api_key_id"`
	Role              string     `json:"role"`
	DisabledAt        *time.Time `json:"disabled_at,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	LastSeenAt        *time.Time `json:"last_seen_at,omitempty"`
}

type OperatorList struct {
	Data []Operator `json:"data"`
}

type OperatorEnvelope struct {
	Operator Operator `json:"operator"`
}

type OperatorCreateRequest struct {
	Name              string   `json:"name"`
	Email             string   `json:"email"`
	SSHPubkey         string   `json:"ssh_pubkey"`
	SSHPubkeyFPSHA256 string   `json:"ssh_pubkey_fp_sha256"`
	Role              string   `json:"role,omitempty"`
	Scopes            []string `json:"scopes,omitempty"`
	RateLimitPerMin   int      `json:"rate_limit_per_min,omitempty"`
}

// OperatorIssueResponse is returned by POST /v1/admin/operators and by
// rotate-key. The api_key_secret + login_token are shown ONCE.
type OperatorIssueResponse struct {
	Operator     Operator `json:"operator,omitempty"`
	APIKeyID     string   `json:"api_key_id"`
	APIKeyPrefix string   `json:"api_key_prefix"`
	APIKeySecret string   `json:"api_key_secret"`
	LoginToken   string   `json:"login_token"`
}

type OperatorUpdateRequest struct {
	Name     string `json:"name,omitempty"`
	Role     string `json:"role,omitempty"`
	Disabled *bool  `json:"disabled,omitempty"`
}

type OperatorRotatePubkeyRequest struct {
	SSHPubkey         string `json:"ssh_pubkey"`
	SSHPubkeyFPSHA256 string `json:"ssh_pubkey_fp_sha256"`
}

type LoginResponse struct {
	Operator LoginOperator `json:"operator"`
}

type LoginOperator struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	APIKeyID string `json:"api_key_id"`
}
