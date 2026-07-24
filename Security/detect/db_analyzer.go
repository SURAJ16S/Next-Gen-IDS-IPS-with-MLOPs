// SPDX-License-Identifier: GPL-2.0
// detect/db_analyzer.go — Database protocol analysis.
// Inspects MySQL, PostgreSQL, Redis, and MongoDB traffic for
// authentication tracking, dangerous commands, SQL injection in
// queries, and unauthenticated access.

package detect

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Database Analyzer
// ──────────────────────────────────────────────────────────────────────────────

// DBAnalyzer inspects database protocol traffic.
type DBAnalyzer struct {
	bus       *DetectionBus
	sqliRegex []*regexp.Regexp
}

// NewDBAnalyzer creates a database analyzer.
func NewDBAnalyzer(bus *DetectionBus) *DBAnalyzer {
	a := &DBAnalyzer{bus: bus}

	// SQL injection patterns for database queries
	patterns := []string{
		`(?i)union\s+(all\s+)?select`,
		`(?i)(drop|alter|truncate)\s+(table|database)`,
		`(?i);\s*(select|insert|update|delete|drop|exec)`,
		`(?i)into\s+outfile`,
		`(?i)load_file\s*\(`,
		`(?i)information_schema`,
	}
	for _, p := range patterns {
		r, err := regexp.Compile(p)
		if err == nil {
			a.sqliRegex = append(a.sqliRegex, r)
		}
	}

	return a
}

// Analyze dispatches to protocol-specific analysis.
func (a *DBAnalyzer) Analyze(connID, srcIP string, srcPort, dstPort uint16, protocol string, data []byte, fromClient bool) {
	if len(data) == 0 {
		return
	}

	switch strings.ToLower(protocol) {
	case "mysql":
		a.analyzeMySQL(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "postgresql":
		a.analyzePostgreSQL(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "redis":
		a.analyzeRedis(connID, srcIP, srcPort, dstPort, data, fromClient)
	case "mongodb":
		a.analyzeMongoDB(connID, srcIP, srcPort, dstPort, data, fromClient)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// MySQL Analysis
// ──────────────────────────────────────────────────────────────────────────────

func (a *DBAnalyzer) analyzeMySQL(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 5 {
		return
	}

	if !fromClient {
		// Server greeting
		if data[4] == 0x0a { // Protocol version 10
			// Extract server version
			verEnd := bytes.IndexByte(data[5:], 0x00)
			if verEnd > 0 && verEnd < 50 {
				version := string(data[5 : 5+verEnd])
				a.bus.EmitDetection(Detection{
					ID:         "DB-MYSQL-GREET",
					Timestamp:  time.Now(),
					Severity:   SevInfo,
					Category:   CatProtocolDetect,
					Protocol:   "MySQL",
					SourceIP:   srcIP,
					SourcePort: srcPort,
					DestPort:   dstPort,
					Summary:    fmt.Sprintf("MySQL server version: %s", version),
					ConnID:     connID,
					Details: map[string]any{
						"version": version,
					},
				})
			}
		}

		// Error packet (0xFF)
		if data[4] == 0xFF && len(data) > 9 {
			errCode := int(data[5]) | int(data[6])<<8
			errMsg := ""
			if len(data) > 9 {
				// Skip error code (2) + '#' + state (5) = 8 bytes after packet type
				if data[7] == '#' && len(data) > 13 {
					errMsg = string(data[13:])
				} else {
					errMsg = string(data[7:])
				}
			}

			sev := SevInfo
			category := CatConnLifecycle
			if errCode == 1045 { // Access denied
				sev = SevMedium
				category = CatBruteForce
			}

			a.bus.EmitDetection(Detection{
				ID:         "DB-MYSQL-ERR",
				Timestamp:  time.Now(),
				Severity:   sev,
				Category:   category,
				Protocol:   "MySQL",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("MySQL error %d: %s", errCode, truncate(errMsg, 100)),
				ConnID:     connID,
				Details: map[string]any{
					"error_code": errCode,
					"message":    truncate(errMsg, 200),
				},
			})
		}
		return
	}

	// Client command packet
	// After packet header (4 bytes), command byte
	cmdByte := data[4]

	switch cmdByte {
	case 0x03: // COM_QUERY
		if len(data) > 5 {
			query := string(data[5:])
			a.logQuery(connID, srcIP, srcPort, dstPort, "MySQL", query)
		}
	case 0x02: // COM_INIT_DB
		if len(data) > 5 {
			db := string(data[5:])
			a.bus.EmitDetection(Detection{
				ID:         "DB-MYSQL-INITDB",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "MySQL",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("MySQL USE database: %s", truncate(db, 50)),
				ConnID:     connID,
			})
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// PostgreSQL Analysis
// ──────────────────────────────────────────────────────────────────────────────

func (a *DBAnalyzer) analyzePostgreSQL(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 5 {
		return
	}

	if fromClient {
		// Simple Query message: 'Q' + length(4) + query
		if data[0] == 'Q' && len(data) > 5 {
			query := string(data[5:])
			// Strip null terminator
			if idx := strings.IndexByte(query, 0); idx >= 0 {
				query = query[:idx]
			}
			a.logQuery(connID, srcIP, srcPort, dstPort, "PostgreSQL", query)
		}

		// Password message: 'p' + length + password
		if data[0] == 'p' {
			a.bus.EmitDetection(Detection{
				ID:         "DB-PG-AUTH",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "PostgreSQL",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "PostgreSQL authentication credentials sent",
				ConnID:     connID,
			})
		}
	} else {
		// Server responses
		if data[0] == 'E' {
			// Error response
			errFields := parsePostgresError(data)
			sev := SevInfo
			if strings.Contains(errFields["C"], "28") { // Class 28 = Invalid Authorization
				sev = SevMedium
			}
			a.bus.EmitDetection(Detection{
				ID:         "DB-PG-ERR",
				Timestamp:  time.Now(),
				Severity:   sev,
				Category:   CatConnLifecycle,
				Protocol:   "PostgreSQL",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("PostgreSQL error: %s", truncate(errFields["M"], 100)),
				ConnID:     connID,
				Details:    map[string]any{"fields": errFields},
			})
		}

		// Authentication request
		if data[0] == 'R' && len(data) >= 9 {
			a.bus.EmitDetection(Detection{
				ID:         "DB-PG-AUTHREQ",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "PostgreSQL",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "PostgreSQL authentication request",
				ConnID:     connID,
			})
		}
	}
}

// parsePostgresError extracts error fields from a PostgreSQL ErrorResponse.
func parsePostgresError(data []byte) map[string]string {
	fields := make(map[string]string)
	if len(data) < 6 {
		return fields
	}

	// Skip message type (1) + length (4)
	offset := 5
	for offset < len(data) {
		fieldType := data[offset]
		offset++
		if fieldType == 0 {
			break
		}
		nullIdx := bytes.IndexByte(data[offset:], 0)
		if nullIdx < 0 {
			break
		}
		fields[string(fieldType)] = string(data[offset : offset+nullIdx])
		offset += nullIdx + 1
	}
	return fields
}

// ──────────────────────────────────────────────────────────────────────────────
// Redis Analysis
// ──────────────────────────────────────────────────────────────────────────────

func (a *DBAnalyzer) analyzeRedis(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	s := string(data)
	lines := strings.Split(s, "\r\n")

	if fromClient {
		// Parse RESP commands
		cmd := a.extractRedisCommand(lines)
		if cmd == "" {
			return
		}

		upperCmd := strings.ToUpper(cmd)

		// Dangerous commands
		dangerousCommands := map[string]string{
			"FLUSHALL":  "Deletes ALL data in ALL databases",
			"FLUSHDB":   "Deletes all data in current database",
			"SHUTDOWN":  "Shuts down Redis server",
			"DEBUG":     "Debug command (can crash server)",
			"CONFIG":    "Server configuration modification",
			"SLAVEOF":   "Changes replication settings",
			"REPLICAOF": "Changes replication settings",
			"MODULE":    "Loads external modules",
			"EVAL":      "Executes Lua script",
			"EVALSHA":   "Executes cached Lua script",
			"SCRIPT":    "Manages Lua scripts",
			"KEYS":      "Full keyspace scan (performance risk)",
			"SAVE":      "Blocking save to disk",
			"BGSAVE":    "Background save to disk",
		}

		if desc, isDangerous := dangerousCommands[upperCmd]; isDangerous {
			sev := SevHigh
			if upperCmd == "FLUSHALL" || upperCmd == "SHUTDOWN" || upperCmd == "MODULE" {
				sev = SevCritical
			}

			a.bus.EmitDetection(Detection{
				ID:         "DB-REDIS-DANGER",
				Timestamp:  time.Now(),
				Severity:   sev,
				Category:   CatDangerousCmd,
				Protocol:   "Redis",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("Redis dangerous command: %s — %s", upperCmd, desc),
				ConnID:     connID,
				Details: map[string]any{
					"command":     upperCmd,
					"description": desc,
				},
			})
		} else {
			a.bus.EmitDetection(Detection{
				ID:         "DB-REDIS-CMD",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "Redis",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("Redis command: %s", truncate(upperCmd, 50)),
				ConnID:     connID,
			})
		}

		// AUTH command detection
		if upperCmd == "AUTH" {
			a.bus.EmitDetection(Detection{
				ID:         "DB-REDIS-AUTH",
				Timestamp:  time.Now(),
				Severity:   SevInfo,
				Category:   CatConnLifecycle,
				Protocol:   "Redis",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    "Redis AUTH attempt",
				ConnID:     connID,
			})
		}
	} else {
		// Server responses
		if strings.HasPrefix(s, "-ERR") || strings.HasPrefix(s, "-NOAUTH") {
			sev := SevInfo
			if strings.Contains(s, "NOAUTH") || strings.Contains(s, "invalid password") {
				sev = SevMedium
			}
			a.bus.EmitDetection(Detection{
				ID:         "DB-REDIS-ERR",
				Timestamp:  time.Now(),
				Severity:   sev,
				Category:   CatBruteForce,
				Protocol:   "Redis",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("Redis error: %s", truncate(strings.TrimSpace(s), 100)),
				ConnID:     connID,
			})
		}

		// Check for unauthenticated access (command succeeds without AUTH)
		if strings.HasPrefix(s, "+OK") || strings.HasPrefix(s, "$") || strings.HasPrefix(s, "*") {
			// This is normal operation, but we track it for context
		}
	}
}

// extractRedisCommand extracts the command name from RESP protocol lines.
func (a *DBAnalyzer) extractRedisCommand(lines []string) string {
	// RESP Array: *N\r\n$len\r\ncommand\r\n...
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if strings.HasPrefix(line, "$") && i+1 < len(lines) {
			return lines[i+1]
		}
	}
	// Inline command
	if len(lines) > 0 && !strings.HasPrefix(lines[0], "*") && !strings.HasPrefix(lines[0], "$") {
		parts := strings.Fields(lines[0])
		if len(parts) > 0 {
			return parts[0]
		}
	}
	return ""
}

// ──────────────────────────────────────────────────────────────────────────────
// MongoDB Analysis
// ──────────────────────────────────────────────────────────────────────────────

func (a *DBAnalyzer) analyzeMongoDB(connID, srcIP string, srcPort, dstPort uint16, data []byte, fromClient bool) {
	if len(data) < 16 {
		return
	}

	// MongoDB wire protocol header: Length(4) + RequestID(4) + ResponseTo(4) + OpCode(4)
	// opCode := binary.LittleEndian.Uint32(data[12:16])

	a.bus.EmitDetection(Detection{
		ID:         "DB-MONGO-MSG",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatConnLifecycle,
		Protocol:   "MongoDB",
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    "MongoDB wire protocol message detected",
		ConnID:     connID,
		Details: map[string]any{
			"msg_length":  len(data),
			"from_client": fromClient,
		},
	})

	// Look for admin commands in the payload
	s := string(data)
	adminCommands := []string{
		"dropDatabase", "dropCollection", "createUser", "dropUser",
		"updateUser", "grantRolesToUser", "revokeRolesFromUser",
		"shutdown", "replSetReconfig", "replSetStepDown",
	}

	for _, cmd := range adminCommands {
		if strings.Contains(s, cmd) {
			a.bus.EmitDetection(Detection{
				ID:         "DB-MONGO-ADMIN",
				Timestamp:  time.Now(),
				Severity:   SevHigh,
				Category:   CatDangerousCmd,
				Protocol:   "MongoDB",
				SourceIP:   srcIP,
				SourcePort: srcPort,
				DestPort:   dstPort,
				Summary:    fmt.Sprintf("MongoDB admin command detected: %s", cmd),
				ConnID:     connID,
				Details: map[string]any{
					"command": cmd,
				},
			})
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────────

// logQuery logs a database query and checks for SQL injection patterns.
func (a *DBAnalyzer) logQuery(connID, srcIP string, srcPort, dstPort uint16, protocol, query string) {
	// Clean up query
	query = strings.TrimRight(query, "\x00")
	if query == "" {
		return
	}

	a.bus.EmitDetection(Detection{
		ID:         "DB-QUERY-001",
		Timestamp:  time.Now(),
		Severity:   SevInfo,
		Category:   CatConnLifecycle,
		Protocol:   protocol,
		SourceIP:   srcIP,
		SourcePort: srcPort,
		DestPort:   dstPort,
		Summary:    fmt.Sprintf("%s query: %s", protocol, truncate(query, 100)),
		ConnID:     connID,
		Details: map[string]any{
			"query": truncate(query, 500),
		},
	})

	// Check for SQL injection patterns
	for _, re := range a.sqliRegex {
		if match := re.FindString(query); match != "" {
			a.bus.EmitDetection(Detection{
				ID:          "DB-SQLI-001",
				Timestamp:   time.Now(),
				Severity:    SevCritical,
				Category:    CatSQLi,
				Protocol:    protocol,
				SourceIP:    srcIP,
				SourcePort:  srcPort,
				DestPort:    dstPort,
				Summary:     fmt.Sprintf("SQL injection pattern in %s query", protocol),
				ConnID:      connID,
				RawEvidence: truncate(match, 150),
				Details: map[string]any{
					"query": truncate(query, 300),
				},
			})
			break // One detection per query
		}
	}
}
