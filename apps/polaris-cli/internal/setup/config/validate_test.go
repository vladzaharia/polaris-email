package config

import (
	"strings"
	"testing"
)

func TestValidate_RequiredFieldsBlank(t *testing.T) {
	t.Parallel()
	err := Validate(&Config{})
	if err == nil {
		t.Fatal("blank config should fail validation")
	}
	if !strings.Contains(err.Error(), "CF_ACCOUNT_ID") {
		t.Errorf("error should mention CF_ACCOUNT_ID: %v", err)
	}
	if !strings.Contains(err.Error(), "POLARIS_API_HOSTNAME") {
		t.Errorf("error should mention POLARIS_API_HOSTNAME: %v", err)
	}
}

func TestValidate_HappyPath(t *testing.T) {
	t.Parallel()
	c := &Config{
		CFAccountID:        "acc",
		PolarisAPIHostname: "api.example.com",
	}
	if err := Validate(c); err != nil {
		t.Errorf("minimal valid config should pass: %v", err)
	}
}

func TestValidate_BadURL(t *testing.T) {
	t.Parallel()
	c := &Config{
		CFAccountID:        "acc",
		PolarisAPIHostname: "api.example.com",
		AlertWebhook:       "not-a-url",
	}
	err := Validate(c)
	if err == nil {
		t.Fatal("bad URL should fail")
	}
	if !strings.Contains(err.Error(), "ALERT_WEBHOOK") {
		t.Errorf("error should name field: %v", err)
	}
}

func TestValidate_BadEmail(t *testing.T) {
	t.Parallel()
	c := &Config{
		CFAccountID:        "acc",
		PolarisAPIHostname: "api.example.com",
		SyntheticFrom:      "not-an-email",
	}
	err := Validate(c)
	if err == nil {
		t.Fatal("bad email should fail")
	}
	if !strings.Contains(err.Error(), "SYNTHETIC_FROM") {
		t.Errorf("error should name field: %v", err)
	}
}

func TestValidate_HostnameWithScheme(t *testing.T) {
	t.Parallel()
	c := &Config{
		CFAccountID:        "acc",
		PolarisAPIHostname: "https://api.example.com",
	}
	if err := Validate(c); err == nil {
		t.Fatal("hostname with scheme should fail")
	}
}

func TestValidate_B2KeyIDOrphan(t *testing.T) {
	t.Parallel()
	c := &Config{
		CFAccountID:         "acc",
		PolarisAPIHostname:  "api.example.com",
		AnchorS3AccessKeyID: "id-only",
	}
	err := Validate(c)
	if err == nil {
		t.Fatal("orphan B2 key id should fail")
	}
	if !strings.Contains(err.Error(), "ANCHOR_S3_SECRET_ACCESS_KEY") {
		t.Errorf("error should call out the missing secret: %v", err)
	}
}

func TestValidate_B2KeysWithoutBucket(t *testing.T) {
	t.Parallel()
	c := &Config{
		CFAccountID:             "acc",
		PolarisAPIHostname:      "api.example.com",
		AnchorS3AccessKeyID:     "id",
		AnchorS3SecretAccessKey: "secret",
	}
	err := Validate(c)
	if err == nil {
		t.Fatal("B2 keys without bucket should fail")
	}
	msg := err.Error()
	if !strings.Contains(msg, "ANCHOR_S3_ENDPOINT") || !strings.Contains(msg, "ANCHOR_S3_BUCKET") {
		t.Errorf("error should name endpoint+bucket: %v", err)
	}
}

func TestValidate_OptionalFieldsBlankIsFine(t *testing.T) {
	t.Parallel()
	c := &Config{
		CFAccountID:        "acc",
		PolarisAPIHostname: "api.example.com",
	}
	// All other fields blank → should pass.
	if err := Validate(c); err != nil {
		t.Errorf("optional-blank config should pass: %v", err)
	}
}
