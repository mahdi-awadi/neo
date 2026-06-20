package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"

	"github.com/mahdi-awadi/gopkg/communication/provider"
)

// signTwilio reproduces Twilio's webhook signature for test fixtures.
func signTwilio(token, fullURL string, form url.Values) string {
	keys := make([]string, 0, len(form))
	for k := range form {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(fullURL)
	for _, k := range keys {
		b.WriteString(k)
		b.WriteString(form.Get(k))
	}
	mac := hmac.New(sha1.New, []byte(token))
	mac.Write([]byte(b.String()))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestTwilioSignatureValid(t *testing.T) {
	form := url.Values{"From": {"whatsapp:+15551234567"}, "Body": {"hi there"}, "MessageSid": {"SM1"}}
	u := "https://neo-api.tech-gate.online/inbound/whatsapp"
	good := signTwilio("tok", u, form)
	if !twilioSignatureValid("tok", u, form, good) {
		t.Fatal("valid signature rejected")
	}
	if twilioSignatureValid("tok", u, form, good+"x") {
		t.Fatal("bad signature accepted")
	}
	if twilioSignatureValid("tok", u, form, "") {
		t.Fatal("empty signature accepted")
	}
	if twilioSignatureValid("", u, form, good) {
		t.Fatal("empty auth token must reject")
	}
}

// fakeWASender records what the gateway tried to send over WhatsApp.
type fakeWASender struct {
	to, body string
	calls    int
}

func (f *fakeWASender) Send(_ context.Context, req *provider.SendRequest) (*provider.SendResponse, error) {
	f.calls++
	f.to, f.body = req.RecipientPhone, req.Body
	return &provider.SendResponse{Success: true}, nil
}

func newWAGateway(token string, sender *fakeWASender) (*gateway, string) {
	u := "https://gw.example/inbound/whatsapp"
	gw := &gateway{
		store:           newMemCache(),
		waSender:        sender,
		twilioAuthToken: token,
		publicURL:       "https://gw.example",
		waReplyFn: func(_ context.Context, sender, name string, history []conversationMessage, userText string) (string, error) {
			// echo-with-context so the test can assert sender/name/history reach the front-desk
			return "reply to " + name + "(" + sender + "): " + userText + " (hist=" + itoa(len(history)) + ")", nil
		},
	}
	return gw, u
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d []byte
	for n > 0 {
		d = append([]byte{byte('0' + n%10)}, d...)
		n /= 10
	}
	return string(d)
}

func postWA(gw *gateway, u, token string, form url.Values, sign bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, u, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if sign {
		req.Header.Set("X-Twilio-Signature", signTwilio(token, u, form))
	}
	rec := httptest.NewRecorder()
	gw.handleInboundWhatsApp(rec, req)
	return rec
}

func TestHandleInboundWhatsAppRepliesAndPersists(t *testing.T) {
	sender := &fakeWASender{}
	gw, u := newWAGateway("tok", sender)
	form := url.Values{"From": {"whatsapp:+15551234567"}, "Body": {"where is my order"}, "MessageSid": {"SM1"}}

	rec := postWA(gw, u, "tok", form, true)

	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if sender.calls != 1 || sender.to != "+15551234567" {
		t.Fatalf("send to=%q calls=%d", sender.to, sender.calls)
	}
	if !strings.Contains(sender.body, "where is my order") {
		t.Fatalf("reply body = %q", sender.body)
	}
	// Both turns persisted under the per-sender key.
	hist, _ := gw.store.Recent(context.Background(), "whatsapp:+15551234567", 10)
	if len(hist) != 2 || hist[0].Role != "user" || hist[1].Role != "model" {
		t.Fatalf("history = %+v", hist)
	}
}

func TestHandleInboundWhatsAppRejectsBadSignature(t *testing.T) {
	sender := &fakeWASender{}
	gw, u := newWAGateway("tok", sender)
	form := url.Values{"From": {"whatsapp:+1"}, "Body": {"hi"}}
	req := httptest.NewRequest(http.MethodPost, u, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Twilio-Signature", "bogus")
	rec := httptest.NewRecorder()
	gw.handleInboundWhatsApp(rec, req)
	if rec.Code != 401 {
		t.Fatalf("want 401, got %d", rec.Code)
	}
	if sender.calls != 0 {
		t.Fatal("must not send on bad signature")
	}
}

func TestHandleInboundWhatsAppEmptyBodyIsNoOp(t *testing.T) {
	sender := &fakeWASender{}
	gw, u := newWAGateway("tok", sender)
	form := url.Values{"From": {"whatsapp:+1"}, "Body": {"   "}, "MessageStatus": {"delivered"}}
	rec := postWA(gw, u, "tok", form, true)
	if rec.Code != 200 || sender.calls != 0 {
		t.Fatalf("empty body should be a 200 no-op; code=%d calls=%d", rec.Code, sender.calls)
	}
}
