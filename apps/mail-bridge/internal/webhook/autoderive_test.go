package webhook

import "testing"

func TestAutoDeriveURL_Priority(t *testing.T) {
	cases := []struct {
		name string
		in   AutoDeriveInput
		want string
	}{
		{
			name: "tailnet-wins",
			in: AutoDeriveInput{
				TailnetFQDN: "greenwood-mail.tail-scale.ts.net",
				FQDN:        "greenwood.mail.plrs.im",
				IP:          "10.0.0.4",
			},
			want: "http://greenwood-mail.tail-scale.ts.net:8080/internal/webhook/message-received",
		},
		{
			name: "fqdn-when-no-tailnet",
			in: AutoDeriveInput{
				FQDN: "greenwood.mail.plrs.im",
				IP:   "10.0.0.4",
			},
			want: "https://greenwood.mail.plrs.im:8080/internal/webhook/message-received",
		},
		{
			name: "ip-fallback",
			in:   AutoDeriveInput{IP: "10.0.0.4"},
			want: "http://10.0.0.4:8080/internal/webhook/message-received",
		},
		{
			name: "ipv6-bracketed",
			in:   AutoDeriveInput{IP: "2001:db8::1"},
			want: "http://[2001:db8::1]:8080/internal/webhook/message-received",
		},
		{
			name: "default-port-suppressed-http",
			in:   AutoDeriveInput{FQDN: "greenwood.mail.plrs.im", Scheme: "http", ListenPort: 80},
			want: "http://greenwood.mail.plrs.im/internal/webhook/message-received",
		},
		{
			name: "default-port-suppressed-https",
			in:   AutoDeriveInput{FQDN: "greenwood.mail.plrs.im", ListenPort: 443},
			want: "https://greenwood.mail.plrs.im/internal/webhook/message-received",
		},
		{
			name: "custom-path-leading-slash-added",
			in:   AutoDeriveInput{FQDN: "x.example.com", Path: "hook"},
			want: "https://x.example.com:8080/hook",
		},
		{
			name: "empty-input-returns-empty",
			in:   AutoDeriveInput{},
			want: "",
		},
		{
			name: "whitespace-only-treated-as-empty",
			in:   AutoDeriveInput{TailnetFQDN: "   ", FQDN: "  \t  ", IP: ""},
			want: "",
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			got := AutoDeriveURL(tt.in)
			if got != tt.want {
				t.Errorf("AutoDeriveURL = %q, want %q", got, tt.want)
			}
		})
	}
}
