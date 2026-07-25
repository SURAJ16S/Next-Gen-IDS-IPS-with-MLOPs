// SPDX-License-Identifier: GPL-2.0
// detect/http_analyzer.go — HTTP deep inspection and attack signature detection.
// Parses HTTP requests/responses, extracts all headers, and scans for 40+
// attack patterns including SQLi, XSS, path traversal, command injection,
// SSRF, XXE, Log4Shell, HTTP smuggling, and more.

package detect

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// HTTP Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// HTTPAnalyzer performs deep inspection of HTTP traffic.
type HTTPAnalyzer struct {
	bus            *DetectionBus
	patterns       []attackPattern
	mu             sync.Mutex
	reqTimes       map[string]time.Time
	sessionTracker *SessionTracker
}

type attackPattern struct {
	id       string
	name     string
	category string
	severity Severity
	regex    *regexp.Regexp
}

const RequestTimeout = 5 * time.Minute

// NewHTTPAnalyzer creates an HTTP analyzer with all attack signatures compiled.
func NewHTTPAnalyzer(ctx context.Context, bus *DetectionBus) *HTTPAnalyzer {
	a := &HTTPAnalyzer{
		bus:            bus,
		reqTimes:       make(map[string]time.Time),
		sessionTracker: NewSessionTracker(bus),
	}
	a.compilePatterns()
	bus.Subscribe(a)
	go a.cleanupStaleReqTimes(ctx)
	return a
}

func (a *HTTPAnalyzer) cleanupStaleReqTimes(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.mu.Lock()
			now := time.Now()
			for connID, t := range a.reqTimes {
				if now.Sub(t) > RequestTimeout {
					delete(a.reqTimes, connID)
				}
			}
			a.mu.Unlock()
		}
	}
}

// ── DetectionSubscriber Implementation ──

func (a *HTTPAnalyzer) OnDetection(d Detection) {}

func (a *HTTPAnalyzer) OnConnectionClose(c ConnectionRecord) {
	a.mu.Lock()
	delete(a.reqTimes, c.ConnID)
	a.mu.Unlock()
}

// compilePatterns builds the regex-based attack signature database.
func (a *HTTPAnalyzer) compilePatterns() {
	raw := []struct {
		id       string
		name     string
		category string
		severity Severity
		pattern  string
	}{
		// ── SQL Injection ──
		{"HTTP-SQLI-001", "SQL UNION SELECT", CatSQLi, SevHigh, `(?i)union\s+(all\s+)?select`},
		{"HTTP-SQLI-002", "SQL OR 1=1", CatSQLi, SevHigh, `(?i)(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+`},
		{"HTTP-SQLI-003", "SQL Comment Injection", CatSQLi, SevMedium, `(?i)(--|/\*|\*/|#)\s*(select|union|drop|insert|update|delete)`},
		{"HTTP-SQLI-004", "SQL DROP/ALTER", CatSQLi, SevCritical, `(?i)(drop|alter|truncate)\s+(table|database|schema|index)`},
		{"HTTP-SQLI-005", "SQL Time-based Blind", CatSQLi, SevHigh, `(?i)(sleep|benchmark|waitfor\s+delay|pg_sleep)\s*\(`},
		{"HTTP-SQLI-006", "SQL Boolean Blind", CatSQLi, SevHigh, `(?i)(if|case)\s*\(.*select`},
		{"HTTP-SQLI-007", "SQL INFORMATION_SCHEMA", CatSQLi, SevHigh, `(?i)information_schema\.(tables|columns|schemata)`},
		{"HTTP-SQLI-008", "SQL String Concat", CatSQLi, SevMedium, `(?i)(concat|group_concat|char)\s*\(`},
		{"HTTP-SQLI-009", "SQL Hex Encoding", CatSQLi, SevMedium, `(?i)0x[0-9a-f]{8,}`},
		{"HTTP-SQLI-010", "SQL EXEC/EXECUTE", CatSQLi, SevHigh, `(?i)(exec|execute)\s*(sp_|xp_)`},

		// ── Cross-Site Scripting (XSS) ──
		{"HTTP-XSS-001", "XSS Script Tag", CatXSS, SevHigh, `(?i)<\s*script[^>]*>`},
		{"HTTP-XSS-002", "XSS Event Handler", CatXSS, SevHigh, `(?i)\bon(error|load|click|mouseover|focus|blur|submit|change|input|keyup|keydown)\s*=`},
		{"HTTP-XSS-003", "XSS javascript: URI", CatXSS, SevHigh, `(?i)javascript\s*:`},
		{"HTTP-XSS-004", "XSS data: URI", CatXSS, SevMedium, `(?i)data\s*:\s*text/html`},
		{"HTTP-XSS-005", "XSS SVG onload", CatXSS, SevHigh, `(?i)<\s*svg[^>]*\s+onload\s*=`},
		{"HTTP-XSS-006", "XSS img onerror", CatXSS, SevHigh, `(?i)<\s*img[^>]*\s+onerror\s*=`},
		{"HTTP-XSS-007", "XSS iframe injection", CatXSS, SevHigh, `(?i)<\s*iframe[^>]*>`},
		{"HTTP-XSS-008", "XSS expression()", CatXSS, SevMedium, `(?i)expression\s*\(`},

		// ── Path Traversal ──
		{"HTTP-TRAV-001", "Path Traversal ../", CatPathTraversal, SevHigh, `(?i)(\.\.(/|\\)){2,}`},
		{"HTTP-TRAV-002", "Path Traversal Encoded", CatPathTraversal, SevHigh, `(?i)(%2e%2e|%252e%252e|\.%2e|%2e\.)(\/|%2f|\\|%5c)`},
		{"HTTP-TRAV-003", "Path Traversal Null Byte", CatPathTraversal, SevHigh, `%00`},
		{"HTTP-TRAV-004", "Sensitive File Access", CatPathTraversal, SevHigh, `(?i)(/etc/passwd|/etc/shadow|/proc/self|/windows/system32|boot\.ini|web\.config)`},

		// ── Command Injection ──
		{"HTTP-CMDI-001", "Command Injection Pipe", CatCommandInjection, SevCritical, `(?i)[|;&]\s*(cat|ls|dir|whoami|id|uname|pwd|wget|curl|nc|ncat|bash|sh|cmd|powershell)`},
		{"HTTP-CMDI-002", "Command Injection Backtick", CatCommandInjection, SevCritical, "(?i)`[^`]*(cat|ls|whoami|id|uname|pwd|wget|curl)`"},
		{"HTTP-CMDI-003", "Command Injection $()", CatCommandInjection, SevCritical, `(?i)\$\(\s*(cat|ls|whoami|id|uname|pwd|wget|curl|bash)`},
		{"HTTP-CMDI-004", "Command Injection /bin/", CatCommandInjection, SevHigh, `(?i)(/bin/|/usr/bin/|/sbin/)(sh|bash|zsh|dash|csh)`},

		// ── SSRF ──
		{"HTTP-SSRF-001", "SSRF Internal IP", CatSSRF, SevHigh, `(?i)(https?://)(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[::1?\]|localhost)`},
		{"HTTP-SSRF-002", "SSRF Cloud Metadata", CatSSRF, SevCritical, `(?i)(169\.254\.169\.254|metadata\.google|metadata\.internal|100\.100\.100\.200)`},

		// ── XXE ──
		{"HTTP-XXE-001", "XXE Entity Declaration", CatXXE, SevCritical, `(?i)<\s*!\s*(DOCTYPE|ENTITY)\s+`},
		{"HTTP-XXE-002", "XXE External Entity", CatXXE, SevCritical, `(?i)SYSTEM\s+["'](https?://|file://|ftp://|php://|expect://)`},

		// ── Log4Shell ──
		{"HTTP-LOG4-001", "Log4Shell JNDI", CatLog4Shell, SevCritical, `(?i)\$\{(jndi|lower|upper|env|sys|java):`},
		{"HTTP-LOG4-002", "Log4Shell Obfuscated", CatLog4Shell, SevCritical, `(?i)\$\{[^}]*\$\{`},

		// ── HTTP Smuggling ──
		{"HTTP-SMUG-001", "HTTP Smuggling CL+TE", CatHTTPSmuggling, SevHigh, `(?i)transfer-encoding\s*:\s*chunked.*content-length\s*:|content-length\s*:.*transfer-encoding\s*:\s*chunked`},
		{"HTTP-SMUG-002", "Malformed Chunked Encoding", CatHTTPSmuggling, SevHigh, `(?i)transfer-encoding\s*:\s*(chunked\s*,|,\s*chunked|identity\s*,\s*chunked)`},

		// ── CRLF Injection ──
		{"HTTP-CRLF-001", "CRLF in URL", CatCRLFInjection, SevHigh, `(%0d%0a|%0D%0A|\r\n)`},

		// ── LDAP Injection ──
		{"HTTP-LDAP-001", "LDAP Injection", CatLDAPInjection, SevHigh, `(?i)(\*\)\(|[)(]cn=|[)(]uid=|[)(]objectClass=)`},

		// ── File Upload Risk ──
		{"HTTP-UPLD-001", "Executable Upload", CatFileUpload, SevHigh, `(?i)\.(php[3-8]?|phtml|asp|aspx|jsp|jspx|exe|dll|bat|cmd|ps1|sh|cgi|py|pl|rb|war|jar)\b`},
	}

	for _, r := range raw {
		compiled, err := regexp.Compile(r.pattern)
		if err != nil {
			continue // Skip invalid patterns
		}
		a.patterns = append(a.patterns, attackPattern{
			id:       r.id,
			name:     r.name,
			category: r.category,
			severity: r.severity,
			regex:    compiled,
		})
	}
}

// Analyze inspects HTTP data and emits detections.
func (a *HTTPAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	s := string(data)

	if fromClient {
		a.analyzeRequest(connID, srcIP, srcPort, dstPort, s, data)
	} else {
		a.analyzeResponse(connID, srcIP, srcPort, dstPort, s, data)
	}
}

// analyzeRequest performs deep inspection of an HTTP request.
func (a *HTTPAnalyzer) analyzeRequest(connID, srcIP string, srcPort, dstPort uint16, s string, raw []byte) {

	// Parse request line
	lines := strings.SplitN(s, "\r\n", -1)
	if len(lines) == 0 {
		return
	}

	requestLine := lines[0]
	parts := strings.SplitN(requestLine, " ", 3)
	method := ""
	uri := ""
	httpVer := ""
	if len(parts) >= 2 {
		method = parts[0]
		uri = parts[1]
	}
	if len(parts) >= 3 {
		httpVer = parts[2]
	}

	if strings.TrimSpace(method) == "" || strings.TrimSpace(uri) == "" {
		if len(strings.TrimSpace(s)) == 0 {
			// Pure whitespace/newlines. Likely a keep-alive or health probe.
			return
		}
		a.bus.EmitDetection(Detection{
			ID:         "HTTP-ERR-002",
			Timestamp:  time.Now(),
			Severity:   SevLow,
			Category:   "malformed-http",
			Protocol:   "HTTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    "Malformed HTTP request",
			ConnID:     connID,
		})
		return
	}

	a.mu.Lock()
	a.reqTimes[connID] = time.Now()
	a.mu.Unlock()

	// Parse headers
	headers := make(map[string]string)
	headerEnd := 0
	for i := 1; i < len(lines); i++ {
		line := lines[i]
		if line == "" {
			headerEnd = i
			break
		}
		if idx := strings.Index(line, ": "); idx > 0 {
			key := strings.ToLower(line[:idx])
			value := line[idx+2:]
			headers[key] = value
		}
	}

	// Extract body (after blank line)
	body := ""
	if headerEnd > 0 && headerEnd+1 < len(lines) {
		body = strings.Join(lines[headerEnd+1:], "\r\n")
	}

	// ── Compute request feature metadata ──
	uriLen := len(uri)
	queryParams := 0
	queryString := ""
	if qIdx := strings.Index(uri, "?"); qIdx >= 0 {
		queryString = uri[qIdx+1:]
		if queryString != "" {
			queryParams = len(strings.Split(queryString, "&"))
		}
	}
	headerCount := len(headers)
	headerSize := 0
	duplicateHeaders := 0
	headerKeySeen := make(map[string]bool)
	for i := 1; i < len(lines); i++ {
		if lines[i] == "" {
			break
		}
		headerSize += len(lines[i])
		if idx := strings.Index(lines[i], ": "); idx > 0 {
			key := strings.ToLower(lines[i][:idx])
			if headerKeySeen[key] {
				duplicateHeaders++
			}
			headerKeySeen[key] = true
		}
	}
	contentLength := 0
	if cl := headers["content-length"]; cl != "" {
		contentLength, _ = strconv.Atoi(cl)
	}
	jwtPresent := strings.Contains(headers["authorization"], "Bearer ") ||
		strings.Contains(headers["cookie"], "eyJ")
	authPresent := headers["authorization"] != ""

	// ── Emit request metadata detection (INFO level) ──
	a.bus.EmitDetection(Detection{
		ID:         "HTTP-REQ-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatConnLifecycle,
		Protocol:   "HTTP",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("%s %s %s", method, truncate(uri, 100), httpVer),
		ConnID:     connID,
		Details: map[string]any{
			"method":       method,
			"uri":          uri,
			"http_version": httpVer,
			"host":         headers["host"],
			"user_agent":   headers["user-agent"],
			"content_type": headers["content-type"],
			"referer":      headers["referer"],
			"cookie_count": countCookies(headers["cookie"]),
		},
	})

	// ── Session Tracking ──
	a.sessionTracker.TrackRequest(srcIP, headers["user-agent"], uri)

	// ── Emit ML feature vector for this request (HTTP-FEAT-001) ──
	uriStats := ComputePayloadStats(uri)
	bodyStats := ComputePayloadStats(body)
	uaStats := ComputePayloadStats(headers["user-agent"])

	a.bus.EmitDetection(Detection{
		ID:         "HTTP-FEAT-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   "ml-features",
		Protocol:   "HTTP",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("Request features: %s %s", method, truncate(uri, 60)),
		ConnID:     connID,
		Details: map[string]any{
			// ── Request Metadata ──
			"method":            method,
			"uri_length":        uriLen,
			"query_param_count": queryParams,
			"content_length":    contentLength,
			"header_count":      headerCount,
			"header_size":       headerSize,
			"duplicate_headers": duplicateHeaders,
			"cookie_count":      countCookies(headers["cookie"]),
			"jwt_present":       jwtPresent,
			"auth_present":      authPresent,
			"has_referer":       headers["referer"] != "",
			"has_origin":        headers["origin"] != "",
			"accept":            truncate(headers["accept"], 100),
			"accept_encoding":   headers["accept-encoding"],
			"accept_language":   truncate(headers["accept-language"], 50),

			// ── URI Statistical Features ──
			"uri_entropy":            uriStats.Entropy,
			"uri_digit_ratio":        uriStats.DigitRatio,
			"uri_upper_ratio":        uriStats.UpperRatio,
			"uri_special_char_ratio": uriStats.SpecialCharRatio,
			"uri_sql_keyword_count":  uriStats.SQLKeywordCount,
			"uri_xss_pattern_count":  uriStats.XSSPatternCount,
			"uri_path_trav_count":    uriStats.PathTraversalCount,
			"uri_cmd_inject_count":   uriStats.CmdInjectionCount,
			"uri_hex_count":          uriStats.HexCount,
			"uri_base64_count":       uriStats.Base64Count,

			// ── Body Statistical Features ──
			"body_length":              bodyStats.Length,
			"body_entropy":             bodyStats.Entropy,
			"body_digit_ratio":         bodyStats.DigitRatio,
			"body_special_char_ratio":  bodyStats.SpecialCharRatio,
			"body_non_printable_ratio": bodyStats.NonPrintableRatio,
			"body_sql_keyword_count":   bodyStats.SQLKeywordCount,
			"body_xss_pattern_count":   bodyStats.XSSPatternCount,
			"body_html_tag_count":      bodyStats.HTMLTagCount,
			"body_js_pattern_count":    bodyStats.JSPatternCount,
			"body_base64_count":        bodyStats.Base64Count,
			"body_hex_count":           bodyStats.HexCount,
			"body_token_count":         bodyStats.TokenCount,
			"body_avg_token_length":    bodyStats.AvgTokenLength,
			"body_max_token_length":    bodyStats.MaxTokenLength,

			// ── User-Agent Features ──
			"ua_length":  uaStats.Length,
			"ua_entropy": uaStats.Entropy,
		},
	})

	// ── User-Agent fingerprinting ──
	a.analyzeUserAgent(connID, srcIP, srcPort, dstPort, headers["user-agent"])

	// ── URL decoding for analysis ──
	decodedURI := uri
	if decoded, err := url.QueryUnescape(uri); err == nil {
		decodedURI = decoded
	}
	// Double-decode to catch encoding tricks
	if doubleDecoded, err := url.QueryUnescape(decodedURI); err == nil && doubleDecoded != decodedURI {
		decodedURI = doubleDecoded
	}

	// ── Scan all attack patterns against URI, headers, and body ──
	scanTargets := []struct {
		location string
		content  string
	}{
		{"uri", uri},
		{"decoded_uri", decodedURI},
		{"body", body},
		{"user-agent", headers["user-agent"]},
		{"referer", headers["referer"]},
		{"cookie", headers["cookie"]},
		{"x-forwarded-for", headers["x-forwarded-for"]},
		{"authorization", headers["authorization"]},
	}

	for _, target := range scanTargets {
		if target.content == "" {
			continue
		}
		for _, pat := range a.patterns {
			if pat.regex.MatchString(target.content) {
				match := pat.regex.FindString(target.content)
				a.bus.EmitDetection(Detection{
					ID:         pat.id,
					Timestamp:  time.Now(),
					Severity:   pat.severity,
					Category:   pat.category,
					Protocol:   "HTTP",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   dstPort,
					Summary:    fmt.Sprintf("%s detected in %s", pat.name, target.location),
					ConnID:     connID,
					Details: map[string]any{
						"attack":   pat.name,
						"location": target.location,
						"method":   method,
						"uri":      truncate(uri, 200),
					},
					RawEvidence: truncate(match, 200),
				})
			}
		}
	}

	// ── HTTP Smuggling detection (header-level) ──
	a.detectSmuggling(connID, srcIP, srcPort, dstPort, headers, s)

	// ── Credential in URL ──
	if strings.Contains(uri, "password=") || strings.Contains(uri, "passwd=") ||
		strings.Contains(uri, "pwd=") || strings.Contains(uri, "token=") ||
		strings.Contains(uri, "api_key=") || strings.Contains(uri, "secret=") {
		a.bus.EmitDetection(Detection{
			ID:         "HTTP-CRED-001",
			Timestamp:  time.Now(),
			Severity:   SevMedium,
			Category:   CatCredentialLeak,
			Protocol:   "HTTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    "Credentials or secrets found in URL query string",
			ConnID:     connID,
			Details: map[string]any{
				"uri": truncate(uri, 200),
			},
		})
	}

	// ── WebSocket upgrade detection ──
	if strings.EqualFold(headers["upgrade"], "websocket") {
		a.bus.EmitDetection(Detection{
			ID:         "HTTP-WS-001",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatConnLifecycle,
			Protocol:   "HTTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    "WebSocket upgrade request detected",
			ConnID:     connID,
			Details: map[string]any{
				"ws_key":      headers["sec-websocket-key"],
				"ws_version":  headers["sec-websocket-version"],
				"ws_protocol": headers["sec-websocket-protocol"],
			},
		})
	}
}

// analyzeResponse inspects HTTP response for information leakage and security headers.
func (a *HTTPAnalyzer) analyzeResponse(connID, srcIP string, srcPort, dstPort uint16, s string, raw []byte) {
	a.mu.Lock()
	reqTime, ok := a.reqTimes[connID]
	if ok {
		delete(a.reqTimes, connID)
	}
	a.mu.Unlock()

	responseTimeMs := float64(0)
	if ok {
		responseTimeMs = float64(time.Since(reqTime).Milliseconds())
	}

	lines := strings.SplitN(s, "\r\n", -1)
	if len(lines) == 0 {
		return
	}

	// Parse status line
	statusLine := lines[0]
	statusCode := 0
	if len(statusLine) >= 12 {
		fmt.Sscanf(statusLine[9:12], "%d", &statusCode)
	}

	if statusCode == 0 {
		if ok {
			a.bus.EmitDetection(Detection{
				ID:         "HTTP-ERR-001",
				Timestamp:  time.Now(),
				Severity:   SevMedium,
				Category:   "backend-error",
				Protocol:   "HTTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "Connection closed by server without HTTP response",
				ConnID:     connID,
			})
		}
		return
	}

	// Parse response headers
	headers := make(map[string]string)
	headerEnd := 0
	respHeaderCount := 0
	for i := 1; i < len(lines); i++ {
		if lines[i] == "" {
			headerEnd = i
			break
		}
		if idx := strings.Index(lines[i], ": "); idx > 0 {
			key := strings.ToLower(lines[i][:idx])
			headers[key] = lines[i][idx+2:]
			respHeaderCount++
		}
	}

	body := ""
	if headerEnd > 0 && headerEnd+1 < len(lines) {
		body = strings.Join(lines[headerEnd+1:], "\r\n")
	}

	// ── Server header fingerprinting ──
	if server := headers["server"]; server != "" {
		a.bus.EmitDetection(Detection{
			ID:         "HTTP-RESP-001",
			Timestamp:  time.Now(),
			Severity:   SevInfo,
			Category:   CatInfoLeakage,
			Protocol:   "HTTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("Server: %s", truncate(server, 100)),
			ConnID:     connID,
			Details: map[string]any{
				"server":      server,
				"status_code": statusCode,
			},
		})
	}

	// ── Missing security headers ──
	securityHeaders := map[string]string{
		"content-security-policy":   "Content-Security-Policy",
		"x-frame-options":           "X-Frame-Options",
		"x-content-type-options":    "X-Content-Type-Options",
		"strict-transport-security": "Strict-Transport-Security (HSTS)",
		"x-xss-protection":          "X-XSS-Protection",
		"referrer-policy":           "Referrer-Policy",
	}

	missing := []string{}
	for hdr, name := range securityHeaders {
		if _, exists := headers[hdr]; !exists {
			missing = append(missing, name)
		}
	}

	if len(missing) > 0 && statusCode >= 200 && statusCode < 400 {
		a.bus.EmitDetection(Detection{
			ID:         "HTTP-HDR-001",
			Timestamp:  time.Now(),
			Severity:   SevLow,
			Category:   CatMissingHeaders,
			Protocol:   "HTTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    fmt.Sprintf("Missing %d security headers", len(missing)),
			ConnID:     connID,
			Details: map[string]any{
				"missing_headers": missing,
				"status_code":     statusCode,
			},
		})
	}

	// ── Emit ML response feature vector (HTTP-FEAT-002) ──
	respContentLength := 0
	if cl := headers["content-length"]; cl != "" {
		respContentLength, _ = strconv.Atoi(cl)
	}
	hasCompression := headers["content-encoding"] != ""
	cacheControl := headers["cache-control"]
	respBodyStats := ComputePayloadStats(body)

	a.bus.EmitDetection(Detection{
		ID:         "HTTP-FEAT-002",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   "ml-features",
		Protocol:   "HTTP",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("Response features: status=%d size=%d", statusCode, respContentLength),
		ConnID:     connID,
		Details: map[string]any{
			"status_code":                statusCode,
			"response_size":              respContentLength,
			"response_time_ms":           responseTimeMs,
			"resp_header_count":          respHeaderCount,
			"has_compression":            hasCompression,
			"content_type":               headers["content-type"],
			"cache_control":              cacheControl,
			"server":                     headers["server"],
			"missing_security_headers":   len(missing),
			"resp_body_entropy":          respBodyStats.Entropy,
			"resp_body_length":           respBodyStats.Length,
			"resp_body_html_tag_count":   respBodyStats.HTMLTagCount,
			"resp_body_js_pattern_count": respBodyStats.JSPatternCount,
		},
	})

	// ── Information leakage in response body ──
	if body != "" {
		a.detectInfoLeakage(connID, srcIP, srcPort, dstPort, body, statusCode)
	}
}

// analyzeUserAgent classifies the User-Agent string.
func (a *HTTPAnalyzer) analyzeUserAgent(connID, srcIP string, srcPort, dstPort uint16, ua string) {
	if ua == "" {
		a.bus.EmitDetection(Detection{
			ID:         "HTTP-UA-001",
			Timestamp:  time.Now(),
			Severity:   SevLow,
			Category:   CatBotScanner,
			Protocol:   "HTTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    "Request with empty User-Agent",
			ConnID:     connID,
		})
		return
	}

	// Known attack tools
	attackTools := map[string]string{
		"sqlmap":          "SQLMap (SQL injection tool)",
		"nikto":           "Nikto (web vulnerability scanner)",
		"nmap":            "Nmap (network scanner)",
		"masscan":         "Masscan (port scanner)",
		"dirbuster":       "DirBuster (directory brute-forcer)",
		"gobuster":        "Gobuster (directory/DNS brute-forcer)",
		"wfuzz":           "Wfuzz (web fuzzer)",
		"hydra":           "Hydra (brute-force tool)",
		"burpsuite":       "Burp Suite (web proxy/scanner)",
		"zaproxy":         "OWASP ZAP (web scanner)",
		"metasploit":      "Metasploit (exploitation framework)",
		"nuclei":          "Nuclei (vulnerability scanner)",
		"httpx":           "httpx (HTTP probing tool)",
		"censys":          "Censys (internet scanner)",
		"shodan":          "Shodan (internet scanner)",
		"python-requests": "Python Requests library",
		"python-urllib":   "Python urllib library",
		"go-http-client":  "Go HTTP client",
		"curl":            "curl",
		"wget":            "wget",
		"scrapy":          "Scrapy (web scraper)",
	}

	uaLower := strings.ToLower(ua)
	for tool, description := range attackTools {
		if strings.Contains(uaLower, tool) {
			sev := SevMedium
			// Attack-specific tools get higher severity
			if tool == "sqlmap" || tool == "metasploit" || tool == "hydra" {
				sev = SevHigh
			}
			a.bus.EmitDetection(Detection{
				ID:         "HTTP-UA-002",
				Timestamp:  time.Now(),
				Severity:   sev,
				Category:   CatBotScanner,
				Protocol:   "HTTP",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("Known tool detected: %s", description),
				ConnID:     connID,
				Details: map[string]any{
					"tool":       tool,
					"user_agent": truncate(ua, 200),
				},
			})
			return
		}
	}
}

// detectSmuggling checks for HTTP request smuggling indicators.
func (a *HTTPAnalyzer) detectSmuggling(connID, srcIP string, srcPort, dstPort uint16, headers map[string]string, raw string) {
	hasCL := headers["content-length"] != ""
	hasTE := headers["transfer-encoding"] != ""

	if hasCL && hasTE {
		a.bus.EmitDetection(Detection{
			ID:         "HTTP-SMUG-003",
			Timestamp:  time.Now(),
			Severity:   SevHigh,
			Category:   CatHTTPSmuggling,
			Protocol:   "HTTP",
			SourceIP:   srcIP,
			SourcePort: srcPort,
			DestPort:   dstPort,
			Summary:    "Both Content-Length and Transfer-Encoding present (CL+TE smuggling)",
			ConnID:     connID,
			Details: map[string]any{
				"content_length":    headers["content-length"],
				"transfer_encoding": headers["transfer-encoding"],
			},
		})
	}
}

// detectInfoLeakage scans response body for sensitive information exposure.
func (a *HTTPAnalyzer) detectInfoLeakage(connID, srcIP string, srcPort, dstPort uint16, body string, statusCode int) {
	leaks := []struct {
		id      string
		pattern *regexp.Regexp
		name    string
	}{
		{"HTTP-LEAK-001", regexp.MustCompile(`(?i)(stack\s*trace|traceback|at\s+\w+\.\w+\()`), "Stack trace in response"},
		{"HTTP-LEAK-002", regexp.MustCompile(`(?i)(sql\s*error|mysql_error|pg_error|ora-\d{5}|sqlstate)`), "Database error exposed"},
		{"HTTP-LEAK-003", regexp.MustCompile(`(?i)(\/home\/\w+|\/var\/www|C:\\\\(Users|Windows)|\/usr\/local)`), "Internal path disclosed"},
		{"HTTP-LEAK-004", regexp.MustCompile(`(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)`), "Internal IP address leaked"},
		{"HTTP-LEAK-005", regexp.MustCompile(`(?i)(phpinfo|server\s*info|debug\s*mode|development\s*mode)`), "Debug/development info exposed"},
	}

	for _, leak := range leaks {
		if match := leak.pattern.FindString(body); match != "" {
			a.bus.EmitDetection(Detection{
				ID:          leak.id,
				Timestamp:   time.Now(),
				Severity:    SevMedium,
				Category:    CatInfoLeakage,
				Protocol:    "HTTP",
				SourceIP:    srcIP,
				SourcePort:  srcPort,
				DestPort:    dstPort,
				Summary:     leak.name,
				ConnID:      connID,
				RawEvidence: truncate(match, 150),
				Details: map[string]any{
					"status_code": statusCode,
				},
			})
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

func countCookies(cookieHeader string) int {
	if cookieHeader == "" {
		return 0
	}
	return len(strings.Split(cookieHeader, ";"))
}
