// Fixture for rules/custom/neo-go.yaml — intentionally vulnerable. Excluded from scans.
package fixture

import "math/rand"
import "net/http"

func f(r *http.Request, log Logger, u User) {
	// ruleid: neo-go-insecure-random-secret
	otpCode := rand.Intn(999999)
	// ok: neo-go-insecure-random-secret
	jitter := rand.Intn(100)
	// ruleid: neo-go-secret-in-log
	log.Infof("login %s", u.Password)
	// ok: neo-go-secret-in-log
	log.Infof("login %s", u.Email)
	// ruleid: neo-go-cookie-missing-flags
	c1 := http.Cookie{Name: "sid", Value: "x"}
	// ok: neo-go-cookie-missing-flags
	c2 := http.Cookie{Name: "sid", Value: "x", HttpOnly: true, Secure: true}
	// ruleid: neo-go-cors-wildcard-credentials
	cfg := cors.Config{AllowAllOrigins: true, AllowCredentials: true}
	// ruleid: neo-go-client-trusted-price
	p := r.FormValue("price")
	_, _, _, _, _, _ = otpCode, jitter, c1, c2, cfg, p
}
